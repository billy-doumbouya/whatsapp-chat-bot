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
 * Sends a structured prompt request to Gemini via OpenRouter with transient failure fallback
 * @param {{ systemExtra: string, messages: Array }} prompt
 * @param {number} attempt
 * @returns {Promise<string>}
 */
export async function askGemini({ systemExtra, messages }, attempt = 0) {
  try {
    // Isolated Array Structuring: Prevents reference mutation leaks across execution contexts
    const payloadMessages = [
      {
        role: "system",
        content: `${env.bot.persona || ""}${systemExtra || ""}`,
      },
      ...messages,
    ];

    const response = await axios.post(
      OPEN_ROUTER_URL,
      {
        model: env.gemini.model,
        messages: payloadMessages,
        temperature: 0.85,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${env.gemini.apiKey}`,
          "Content-Type": "application/json",
          // OPTIMIZATION: Required OpenRouter analytics and tracking parameters
          "HTTP-Referer": "https://github.com",
          "X-Title": "WhatsApp AI Core Engine",
        },
        timeout: 30000, // 30 second global request gatekeeper
      },
    );

    const text = response.data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Empty response structure received from remote endpoint");
    }

    return text.trim();
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;

    logger.error({ status, detail, attempt }, "[OpenRouter] Request failed");

    // OPTIMIZATION: Fail-fast architecture. Immediately halt retries on authentication or client payload bugs
    const isClientError =
      status && status >= 400 && status < 500 && status !== 429;

    if (isClientError) {
      logger.error(
        "[OpenRouter] Fatal configuration or authentication payload error. Skipping retries.",
      );
      return getRandomFallback();
    }

    // Process Retry Queue for transient errors (Network dropouts, 429 Rate Limits, 5xx server issues)
    if (attempt < MAX_RETRIES) {
      const backoffTime = 1000 * (attempt + 1);
      logger.info(
        `[OpenRouter] Retrying connection loop in ${backoffTime}ms (Attempt ${attempt + 1}/${MAX_RETRIES})...`,
      );

      await new Promise((r) => setTimeout(r, backoffTime));
      return askGemini({ systemExtra, messages }, attempt + 1);
    }

    // Default Fallback
    return getRandomFallback();
  }
}
