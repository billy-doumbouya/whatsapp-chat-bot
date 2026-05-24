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
 * Fonction appelée AUTOMATIQUEMENT par whatsapp.client.js
 * lorsque TU réponds manuellement depuis ton téléphone.
 */
export async function onHumanReply(jid, textContent) {
  try {
    logger.info(
      { jid, textContent: textContent.slice(0, 40) },
      "[Pipeline] Enregistrement de la réponse manuelle de Billy.",
    );
    // Sauvegarde ton propre message dans la base Mongo pour que l'IA connaisse le contexte au prochain message
    await saveMessage(jid, "ai", textContent);
  } catch (err) {
    logger.error(
      { err: err.message, jid },
      "[Pipeline] Échec de l'enregistrement de la réponse humaine",
    );
  }
}

/**
 * Gestionnaire principal des messages ENTRANTS (Amis / Collaborateurs)
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
  console.log("=== MESSAGE TRAITÉ PAR L'IA ===", {
    jid,
    text: text?.slice(0, 50),
    hasAudio: !!audioBuffer,
  });

  // 1. Ignorer les groupes
  if (jid.endsWith("@g.us") && !env.bot.replyGroups) return;

  // 2. Commandes owner (Billy contrôle son instance)
  const isOwner = !!(env.bot.ownerJid && jid === env.bot.ownerJid);
  if (isOwner && text?.startsWith("!")) {
    const handled = await handleOwnerCommand(jid, text);
    if (handled) return;
  }

  // 3. État Pause Global
  if (paused) {
    logger.debug({ jid }, "[Bot] Pause globale active — message ignoré");
    return;
  }

  // 4. Rate limit pour éviter le spam ou les boucles infinies
  if (isRateLimited(jid)) return;

  // 5. Commandes publiques (!reset)
  if (await handlePublicCommand(jid, text)) return;

  const isWife = !!(env.bot.wifeJid && jid === env.bot.wifeJid);
  const wasVoiceMessage = !!audioBuffer;
  let finalText = text;
  let detectedLanguage = "french";

  // 6. Pipeline de transcription si Vocal entrant
  if (wasVoiceMessage) {
    logger.info({ jid }, "[Bot] Transcription du vocal entrant...");
    const result = await transcribeAudio(audioBuffer, audioMime);

    if (result?.text) {
      finalText = result.text; // Extraction du texte brut pur
      detectedLanguage = result.language || "french";
      logger.info(
        { jid, language: detectedLanguage, text: result.text },
        "[Bot] Vocal transcrit avec succès",
      );
    } else {
      // Échec de transcription : réponse neutre sécurisée textuelle
      await sendMessage(
        jid,
        "Reçu, je regarde ça dès que je peux 👍",
        env.bot.typingDelayMs,
      );
      return;
    }
  }

  if (!finalText || finalText.trim() === "") return;

  try {
    // Enregistrement du message entrant dans l'historique Mongo
    const formattedUserMsg = wasVoiceMessage
      ? `[Vocal] ${finalText}`
      : finalText;
    await saveMessage(jid, "user", formattedUserMsg, contactName);

    // Récupération de l'historique fraîchement mis à jour
    const history = await getHistory(jid);

    // Nettoyage de l'historique pour éviter que l'IA ne reproduise les marqueurs "[Vocal]" dans ses réponses
    const cleanHistory = history.map((msg) => ({
      ...msg,
      content: msg.content.replace(/^\[Vocal\]\s*/i, ""),
    }));

    // Construction du prompt structuré avec le payload propre
    const promptPayload = buildPrompt(
      cleanHistory,
      finalText.replace(/^\[Vocal\]\s*/i, ""),
      isWife,
      contactName,
      detectedLanguage,
    );

    logger.debug(
      { jid, historyLength: cleanHistory.length },
      "[Bot] Envoi au LLM Gemini...",
    );

    // Appel de l'IA (Retourne l'objet JSON standardisé)
    const aiResponse = await askGemini(promptPayload);

    // GESTION DU SILENCE OU DU TRANSFERT À L'HUMAIN
    if (aiResponse.requires_human_intervention) {
      logger.info(
        { jid },
        "[Bot] Intervention humaine requise. Alerte envoyée à l'owner.",
      );

      // Optionnel mais hautement recommandé : Alerter Billy si quelqu'un a besoin d'une vraie réponse humaine
      if (env.bot.ownerJid && jid !== env.bot.ownerJid) {
        await sendMessage(
          env.bot.ownerJid,
          `⚠️ *Intervention requise* avec *${contactName || jid}*\nLe bot a passé la main sur le dernier message.`,
        );
      }
      return;
    }

    if (!aiResponse.should_reply) {
      logger.info(
        { jid },
        "[Bot] L'IA a décidé que ce message ne nécessitait pas de réponse.",
      );
      return;
    }

    const cleanReplyText = aiResponse.reply_content;

    // Sauvegarde immédiate de la réponse générée en BDD avant l'envoi WhatsApp
    await saveMessage(jid, "ai", cleanReplyText);

    // 7. Pipeline de Sortie : Traitement de la réponse Vocale
    if (wasVoiceMessage) {
      logger.info(
        { jid, language: detectedLanguage },
        "[Bot] Génération du Text-to-Speech...",
      );

      const audioReply = await textToSpeech(cleanReplyText, detectedLanguage);

      if (audioReply) {
        await sendVoiceMessage(jid, audioReply, env.bot.typingDelayMs);
        logger.info({ jid }, "[Bot] Réponse vocale envoyée ✓");
        return;
      }
      logger.warn(
        { jid },
        "[Bot] Échec du TTS — Fallback automatique sur le format texte",
      );
    }

    // Réponse Textuelle classique
    await sendMessage(jid, cleanReplyText, env.bot.typingDelayMs);
    logger.info({ jid, contactName }, "[Bot] Réponse textuelle envoyée ✓");
  } catch (err) {
    logger.error(
      { err: err.message, jid },
      "[Bot] Échec critique du traitement du message",
    );
  }
}

async function handleOwnerCommand(jid, text) {
  const cmd = text?.trim().replace(/\s+/g, " ").toLowerCase();
  if (!cmd) return false;

  if (cmd === "!pause") {
    paused = true;
    await sendMessage(
      jid,
      "⏸ Bot en pause globale. Je prends la main.\nEnvoie !resume pour réactiver.",
    );
    return true;
  }
  if (cmd === "!resume") {
    paused = false;
    await sendMessage(jid, "▶️ Bot réactivé globalement.");
    return true;
  }
  if (cmd === "!status") {
    const uptimeMin = Math.floor(process.uptime() / 60);
    await sendMessage(
      jid,
      [
        `État Global : ${paused ? "⏸ en pause" : "▶️ actif"}`,
        `Uptime : ${uptimeMin} min`,
        `Owner JID : ${env.bot.ownerJid ?? "non défini"}`,
      ].join("\n"),
    );
    return true;
  }

  const pauseMatch = cmd.match(/^!pause (\d+)$/);
  if (pauseMatch) {
    const minutes = parseInt(pauseMatch[1], 10);
    paused = true;
    await sendMessage(jid, `⏸ Bot en pause globale pendant ${minutes} min.`);
    setTimeout(
      () => {
        paused = false;
        sendMessage(
          jid,
          "▶️ Pause automatique terminée, bot réactivé globalement.",
        );
      },
      minutes * 60 * 1000,
    );
    return true;
  }
  return false;
}

async function handlePublicCommand(jid, text) {
  const cmd = text?.trim().toLowerCase();
  if (cmd === "!reset") {
    const { clearHistory } = await import("./memory.service.js");
    await clearHistory(jid);
    await sendMessage(jid, "Conversation réinitialisée 👍");
    return true;
  }
  return false;
}
