import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const OPEN_ROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MAX_RETRIES = 2;

/**
 * Appel LLM strict JSON
 */
export async function askGemini(messagesPayload, attempt = 0) {
  try {
    if (!Array.isArray(messagesPayload) || messagesPayload.length === 0) {
      throw new Error("Empty payload");
    }

    const finalMessages = [...messagesPayload];

    if (finalMessages[0]?.role === "system") {
      finalMessages[0].content += `

---
# OUTPUT RULES (STRICT)
Return ONLY valid JSON:
{
  "should_reply": boolean,
  "requires_human_intervention": boolean,
  "reply_content": string
}

IMPORTANT:
- If unsure → should_reply = false
- NEVER generate generic fallback text
- NEVER invent polite default replies
`;
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
      { headers: { Authorization: `Bearer ${env.gemini.apiKey}` } },
    );

    const raw = response.data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty response");

    const parsed = JSON.parse(raw.trim());

    return {
      should_reply: Boolean(parsed.should_reply),
      requires_human_intervention: Boolean(parsed.requires_human_intervention),
      reply_content: parsed.reply_content ?? "",
    };
  } catch (err) {
    logger.error({ err: err.message }, "[OpenRouter] failed");

    return {
      should_reply: false,
      requires_human_intervention: true,
      reply_content: "",
    };
  }
}
