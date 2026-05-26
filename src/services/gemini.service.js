import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const OPEN_ROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// FIX: MAX_RETRIES était déclaré mais n'était jamais utilisé.
// La logique de retry est maintenant effective via askWithRetry().
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse la réponse brute du LLM de façon défensive.
 * FIX: strips les fences ```json ... ``` que certains modèles ajoutent
 * malgré response_format: json_object.
 *
 * @param {string} raw
 * @returns {{ should_reply: boolean, requires_human_intervention: boolean, reply_content: string }}
 */
function parseAiResponse(raw) {
  if (!raw) throw new Error("Empty response from LLM");

  // Strip éventuel wrapper markdown ```json ... ```
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  // Validation structurelle minimale
  if (typeof parsed.should_reply !== "boolean") {
    throw new Error("Missing or invalid 'should_reply' field");
  }

  return {
    should_reply: Boolean(parsed.should_reply),
    requires_human_intervention: Boolean(parsed.requires_human_intervention),
    reply_content:
      typeof parsed.reply_content === "string"
        ? parsed.reply_content.trim()
        : "",
  };
}

/**
 * Appel LLM unique (sans retry).
 * @param {Array} messagesPayload
 * @returns {Promise<object>}
 */
async function callLLM(messagesPayload) {
  const finalMessages = [...messagesPayload];

  // Injection des règles de format JSON dans le system prompt
  if (finalMessages[0]?.role === "system") {
    finalMessages[0] = {
      ...finalMessages[0],
      content: `${finalMessages[0].content}

---
# OUTPUT RULES (STRICT)
Return ONLY valid JSON — no markdown fences, no prose before or after:
{
  "should_reply": boolean,
  "requires_human_intervention": boolean,
  "reply_content": string
}

IMPORTANT:
- If unsure → should_reply = false
- NEVER generate generic fallback text
- NEVER invent polite default replies
`,
    };
  }

  const response = await axios.post(
    OPEN_ROUTER_URL,
    {
      model: env.gemini.model,
      messages: finalMessages,
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: "json_object" },
    },
    {
      headers: { Authorization: `Bearer ${env.gemini.apiKey}` },
      // Timeout explicite pour éviter de bloquer le pipeline indéfiniment
      timeout: 15_000,
    },
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  return parseAiResponse(raw);
}

/**
 * Appel LLM avec retry exponentiel.
 * FIX: implémentation effective de MAX_RETRIES (était dead code avant).
 *
 * @param {Array} messagesPayload
 * @param {number} attempt - Numéro de tentative courante (0-indexé)
 * @returns {Promise<object>}
 */
async function askWithRetry(messagesPayload, attempt = 0) {
  try {
    return await callLLM(messagesPayload);
  } catch (err) {
    const isLastAttempt = attempt >= MAX_RETRIES;

    logger.warn(
      { err: err.message, attempt, maxRetries: MAX_RETRIES },
      `[OpenRouter] Attempt ${attempt + 1} failed`,
    );

    if (isLastAttempt) {
      logger.error(
        { err: err.message },
        `[OpenRouter] All ${MAX_RETRIES + 1} attempts failed`,
      );
      return {
        should_reply: false,
        requires_human_intervention: true,
        reply_content: "",
      };
    }

    // Backoff exponentiel : 800ms, 1600ms, …
    await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
    return askWithRetry(messagesPayload, attempt + 1);
  }
}

/**
 * Point d'entrée public : appel LLM strict JSON avec retry.
 *
 * @param {Array} messagesPayload
 * @returns {Promise<{ should_reply: boolean, requires_human_intervention: boolean, reply_content: string }>}
 */
export async function askGemini(messagesPayload) {
  if (!Array.isArray(messagesPayload) || messagesPayload.length === 0) {
    logger.error({}, "[OpenRouter] Empty payload — skipping LLM call");
    return {
      should_reply: false,
      requires_human_intervention: true,
      reply_content: "",
    };
  }

  return askWithRetry(messagesPayload);
}
