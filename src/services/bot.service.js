import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getHistory, saveMessage } from "./memory.service.js";
import { askGemini } from "./gemini.service.js";
import { buildPrompt } from "../helpers/prompt.builder.js";
import { sendMessage, sendVoiceMessage } from "./whatsapp.client.js";
import { isRateLimited } from "../middleware/rateLimiter.js";
import { transcribeAudio } from "./transcription.service.js";
import { textToSpeech } from "./tts.service.js";

let paused = false;

/**
 * Enregistrement des messages envoyés manuellement
 */
export async function onHumanReply(jid, textContent) {
  try {
    if (!textContent?.trim()) return;

    logger.info(
      { jid, textContent: textContent.slice(0, 40) },
      "[Pipeline] Human reply saved",
    );

    await saveMessage(jid, "ai", textContent.trim());
  } catch (err) {
    logger.error(
      { err: err.message, jid },
      "[Pipeline] Failed to save human reply",
    );
  }
}

/**
 * HANDLER PRINCIPAL
 */
export async function handleIncomingMessage(
  sock,
  jid,
  text,
  contactName,
  messageTimestamp,
  audioBuffer,
  audioMime,
) {
  if (jid.endsWith("@g.us") && !env.bot.replyGroups) return;

  const isOwner = env.bot.ownerJid && jid === env.bot.ownerJid;
  if (isOwner && text?.startsWith("!")) {
    if (await handleOwnerCommand(jid, text)) return;
  }

  if (paused) return;
  if (isRateLimited(jid)) return;
  if (await handlePublicCommand(jid, text)) return;

  const isWife = env.bot.wifeJid && jid === env.bot.wifeJid;

  let finalText = text;
  let detectedLanguage = "french";

  const hasAudio = Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0;

  /**
   * STT PIPELINE
   */
  if (hasAudio) {
    try {
      const result = await transcribeAudio(audioBuffer, audioMime);

      if (!result?.text) {
        await sendMessage(jid, "Je n'ai pas bien compris le vocal.");
        return;
      }

      finalText = result.text;
      detectedLanguage = result.language || "french";
    } catch (err) {
      logger.error({ err: err.message }, "[STT] Failure");
      await sendMessage(jid, "Erreur audio temporaire.");
      return;
    }
  }

  if (!finalText?.trim()) return;

  try {
    await saveMessage(
      jid,
      "user",
      hasAudio ? `[Vocal] ${finalText}` : finalText,
      contactName,
    );

    const history = await getHistory(jid);

    const cleanHistory = history.map((m) => ({
      ...m,
      content: m.content.replace(/^\[Vocal\]\s*/i, ""),
    }));

    const promptPayload = buildPrompt(
      cleanHistory,
      finalText.replace(/^\[Vocal\]\s*/i, ""),
      isWife,
      contactName,
      detectedLanguage,
    );

    let aiResponse;

    try {
      aiResponse = await askGemini(promptPayload);
    } catch (err) {
      logger.error({ err: err.message }, "[LLM] Failure");
      await sendMessage(jid, "Je rencontre un problème technique.");
      return;
    }

    if (aiResponse.requires_human_intervention) {
      if (env.bot.ownerJid && jid !== env.bot.ownerJid) {
        await sendMessage(
          env.bot.ownerJid,
          `⚠️ Intervention requise avec ${contactName || jid}`,
        );
      }
      return;
    }

    if (!aiResponse.should_reply) return;

    const reply = aiResponse.reply_content;

    await saveMessage(jid, "ai", reply);

    /**
     * OUTPUT PIPELINE
     */
    if (hasAudio) {
      try {
        const audioReply = await textToSpeech(reply, detectedLanguage);

        if (audioReply) {
          await sendVoiceMessage(jid, audioReply, env.bot.typingDelayMs);
          return;
        }
      } catch (err) {
        logger.warn({ err: err.message }, "[TTS] Fallback to text");
      }
    }

    await sendMessage(jid, reply, env.bot.typingDelayMs);
  } catch (err) {
    logger.error({ err: err.message }, "[Bot] Critical failure");
  }
}
