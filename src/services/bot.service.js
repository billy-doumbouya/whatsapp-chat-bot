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

// ─── Commandes owner ────────────────────────────────────────────────────────

/**
 * Gère les commandes réservées au propriétaire (préfixe !).
 * @param {string} jid
 * @param {string} text
 * @returns {Promise<boolean>} true si la commande a été traitée
 */
async function handleOwnerCommand(jid, text) {
  const cmd = text.toLowerCase().trim();

  if (cmd === "!pause") {
    paused = true;
    await sendMessage(jid, "⏸ Bot en pause.");
    return true;
  }

  if (cmd === "!resume") {
    paused = false;
    await sendMessage(jid, "▶️ Bot repris.");
    return true;
  }

  return false;
}

// ─── Commandes publiques ─────────────────────────────────────────────────────

/**
 * Gère les commandes accessibles à tous les utilisateurs.
 * @param {string} jid
 * @param {string} text
 * @returns {Promise<boolean>} true si la commande a été traitée
 */
async function handlePublicCommand(jid, text) {
  // Placeholder — à étendre selon ton bot
  return false;
}

// ─── Handler réponse humaine ─────────────────────────────────────────────────

/**
 * Enregistre un message envoyé manuellement par l'owner
 * pour maintenir la cohérence de l'historique.
 *
 * @param {string} jid
 * @param {string} textContent
 */
export async function onHumanReply(jid, textContent) {
  try {
    if (!textContent?.trim()) return;

    logger.info(
      { jid, preview: textContent.slice(0, 40) },
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

// ─── Handler principal ───────────────────────────────────────────────────────

/**
 * Traite un message entrant et orchestre STT → LLM → TTS/text.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string}  jid
 * @param {string|null}  text
 * @param {string|null}  contactName
 * @param {number}  messageTimestamp
 * @param {Buffer|null}  audioBuffer
 * @param {string|null}  audioMime
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
  // Filtrage groupes
  if (jid.endsWith("@g.us") && !env.bot.replyGroups) return;

  // Commandes owner
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

  // ── STT ──────────────────────────────────────────────────────────────────
  if (hasAudio) {
    try {
      const result = await transcribeAudio(audioBuffer, audioMime);

      if (!result?.text) {
        await sendMessage(jid, "Je n'ai pas bien compris le vocal.");
        return;
      }

      finalText = result.text;
      detectedLanguage = result.language ?? "french";
    } catch (err) {
      logger.error({ err: err.message }, "[STT] Failure");
      await sendMessage(jid, "Erreur audio temporaire.");
      return;
    }
  }

  if (!finalText?.trim()) return;

  try {
    // Sauvegarde du message user
    await saveMessage(
      jid,
      "user",
      hasAudio ? `[Vocal] ${finalText}` : finalText,
      contactName,
    );

    const history = await getHistory(jid);

    // Nettoyage du préfixe [Vocal] avant d'envoyer au LLM
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

    // ── LLM ────────────────────────────────────────────────────────────────
    let aiResponse;
    try {
      aiResponse = await askGemini(promptPayload);
    } catch (err) {
      // Normalement askGemini ne throw plus grâce au retry,
      // mais on garde ce catch par sécurité.
      logger.error({ err: err.message }, "[LLM] Unhandled failure");
      await sendMessage(jid, "Je rencontre un problème technique.");
      return;
    }

    // Escalade humaine
    if (aiResponse.requires_human_intervention) {
      logger.warn({ jid }, "[Pipeline] Human intervention required");
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
    if (!reply) return;

    // ── OUTPUT ─────────────────────────────────────────────────────────────
    // FIX: saveMessage(ai) déplacé APRÈS l'envoi réel.
    // Avant : si sendVoiceMessage ou sendMessage échouait, la réponse
    // était quand même sauvée en DB → désynchronisation historique.

    if (hasAudio) {
      try {
        const audioReply = await textToSpeech(reply, detectedLanguage);

        if (audioReply) {
          await sendVoiceMessage(jid, audioReply, env.bot.typingDelayMs);
          // Sauvegarde uniquement si l'envoi a réussi
          await saveMessage(jid, "ai", reply);
          return;
        }
      } catch (err) {
        logger.warn({ err: err.message }, "[TTS] Fallback to text");
      }
    }

    await sendMessage(jid, reply, env.bot.typingDelayMs);
    // Sauvegarde uniquement si l'envoi a réussi
    await saveMessage(jid, "ai", reply);
  } catch (err) {
    logger.error({ err: err.message, jid }, "[Bot] Critical failure");
  }
}
