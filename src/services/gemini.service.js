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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function askGemini(prompt, attempt = 0) {
  try {
    const body = {
      model: env.gemini.model,

      messages: [
        {
          role: "system",
          content: env.bot.persona,
        },
        {
          role: "user",
          content: prompt,
        },
      ],

      temperature: 0.85,
      max_tokens: 300,
      top_p: 0.95,
    };

    const response = await axios.post(OPEN_ROUTER_URL, body, {
      timeout: 30000,

      headers: {
        Authorization: `Bearer ${env.gemini.apiKey}`,
        "Content-Type": "application/json",

        // recommandé par OpenRouter
        "HTTP-Referer": env.app.url || "http://localhost:3000",
        "X-Title": env.app.name || "WhatsApp Bot",
      },
    });

    const text = response.data?.choices?.[0]?.message?.content;

    if (!text || typeof text !== "string") {
      throw new Error("Empty response from OpenRouter");
    }

    return text.trim();
  } catch (err) {
    const status = err.response?.status;

    const detail = err.response?.data?.error?.message || err.message;

    logger.error(
      {
        status,
        detail,
        attempt,
      },
      "[Gemini/OpenRouter] Request failed",
    );

    // retry intelligent
    if (attempt < MAX_RETRIES) {
      const delay = 1000 * (attempt + 1);

      logger.info(
        { retry: attempt + 1, delay },
        "[Gemini/OpenRouter] Retrying...",
      );

      await sleep(delay);

      return askGemini(prompt, attempt + 1);
    }

    logger.warn("[Gemini/OpenRouter] All retries failed");

    return getRandomFallback();
  }
}
