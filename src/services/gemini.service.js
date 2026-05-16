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

export async function askGemini(prompt, attempt = 0) {
  console.log("ASK GEMINI CALLED");
  console.log("PROMPT:", prompt);
  try {
    console.log("MODEL:", env.gemini.model);
    console.log("KEY EXISTS:", !!env.gemini.apiKey);
    const response = await axios.post(
      OPEN_ROUTER_URL,
      {
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

        temperature: 0.8,
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

    console.log("OPENROUTER RESPONSE:", JSON.stringify(response.data, null, 2));

    const text = response.data?.choices?.[0]?.message?.content;

    if (!text) {
      throw new Error("Empty response");
    }

    return text.trim();
  } catch (err) {
    console.log("========== OPENROUTER ERROR ==========");
    console.error("OPENROUTER ERROR:", err.response?.data || err.message);

    console.log(err.response?.status);

    console.log(JSON.stringify(err.response?.data, null, 2));

    console.log(err.message);

    console.log("======================================");

    const status = err.response?.status;

    const detail = err.response?.data?.error?.message || err.message;

    logger.error({ status, detail, attempt }, "[OpenRouter] Request failed");

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));

      return askGemini(prompt, attempt + 1);
    }

    return getRandomFallback();
  }
}
