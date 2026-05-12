import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
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
  const url = `${GEMINI_BASE}/${env.gemini.model}:generateContent?key=${env.gemini.apiKey}`;

  const body = {
    system_instruction: {
      parts: [{ text: env.bot.persona }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.85,
      maxOutputTokens: 300,
      topP: 0.95,
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_ONLY_HIGH",
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_ONLY_HIGH",
      },
    ],
  };

  try {
    const res = await axios.post(url, body, { timeout: 30_000 });
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("Empty response from Gemini");
    }

    return text.trim();
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;

    logger.error({ status, detail, attempt }, "[Gemini] Request failed");

    if (attempt < MAX_RETRIES) {
      logger.info({ attempt: attempt + 1 }, "[Gemini] Retrying...");
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return askGemini(prompt, attempt + 1);
    }

    logger.warn("[Gemini] All retries failed, using fallback reply");
    return getRandomFallback();
  }
}
