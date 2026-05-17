import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const OPEN_ROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES = 2;
const FALLBACK_REPLIES = [
  "Je reviens vers toi dans un moment 🙏",
  "Pas dispo là, je te rappelle bientôt.",
  "Reçu ! Je te réponds dès que possible.",
];

function getRandomFallback() {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

/**
 * @param {{ systemExtra: string, messages: Array }} prompt
 * @param {number} attempt
 */
export async function askGemini({ systemExtra, messages }, attempt = 0) {
  try {
    const response = await axios.post(
      OPEN_ROUTER_URL,
      {
        model: env.gemini.model,
        messages: [
          {
            role: "system",
            // Persona complète + contexte spécifique au contact
            content: env.bot.persona + (systemExtra || ""),
          },
          ...messages,
        ],
        temperature: 0.85,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${env.gemini.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    const text = response.data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response");

    return text.trim();
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    logger.error({ status, detail, attempt }, "[OpenRouter] Request failed");

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return askGemini({ systemExtra, messages }, attempt + 1);
    }

    return getRandomFallback();
  }
}
