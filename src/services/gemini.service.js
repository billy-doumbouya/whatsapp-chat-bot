import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const OPEN_ROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MAX_RETRIES = 2;

/**
 * Appel LLM strict JSON
 */
export async function askGemini(messagesPayload, attempt = 0) {
  if (!Array.isArray(messagesPayload) || messagesPayload.length === 0) {
    throw new Error("Invalid LLM payload");
  }

  const finalMessages = [...messagesPayload];

  if (finalMessages[0]?.role === "system") {
    finalMessages[0].content += `

OUTPUT FORMAT:
Return ONLY valid JSON:
{
  "should_reply": true,
  "requires_human_intervention": false,
  "reply_content": ""
}`;
  }

  try {
    const response = await axios.post(
      OPEN_ROUTER_URL,
      {
        model: env.gemini.model,
        messages: finalMessages,
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${env.gemini.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    const raw = response.data?.choices?.[0]?.message?.content;

    if (!raw) throw new Error("Empty LLM response");

    const json = JSON.parse(raw);

    return {
      should_reply: json.should_reply ?? true,
      requires_human_intervention: json.requires_human_intervention ?? false,
      reply_content: json.reply_content ?? "",
    };
  } catch (err) {
    const status = err.response?.status;

    logger.error(
      {
        status,
        detail: err.response?.data || err.message,
        attempt,
      },
      "[LLM ERROR]",
    );

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return askGemini(messagesPayload, attempt + 1);
    }

    throw new Error("LLM_FAILED");
  }
}
