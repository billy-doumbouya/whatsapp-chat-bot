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
let voiceReplyEnabled = process.env.VOICE_REPLY === "true";

// Messages de clôture — pas de réponse nécessaire
const CLOSING_PATTERNS = [
  /^(ok|okay)\.?$/i,
  /^(merci|thanks|thank you|thx)\.?$/i,
  /^(d'accord|dac|ok dac)\.?$/i,
  /^(bonne journée|bonne nuit|bonsoir)\.?$/i,
  /^(bye|au revoir|à bientôt|ciao)\.?$/i,
  /^(👍|🙏|✅|😊|🤝)+$/,
  /^(c'est bon|c est bon|nickel|parfait|super)\.?$/i,
];

function isClosingMessage(text) {
  if (!text) return false;
  return CLOSING_PATTERNS.some((p) => p.test(text.trim()));
}

export async function handleIncomingMessage(
  sock,
  jid,
  text,
  contactName,
  messageTimestamp,
  audioBuffer,
  audioMime,
) {
  console.log("=== MESSAGE RECU ===", {
    jid,
    text: text?.slice(0, 50),
    hasAudio: !!audioBuffer,
  });

  // 1. Ignorer les groupes
  if (jid.endsWith("@g.us") && !env.bot.replyGroups) return;

  // 2. Commandes owner
  const isOwner = !!(env.bot.ownerJid && jid === env.bot.ownerJid);

  if (text?.startsWith("!")) {
    logger.info(
      {
        jid,
        ownerJid: env.bot.ownerJid ?? "NON DÉFINI",
        isOwner,
        cmd: text.trim(),
      },
      "[Bot] Commande reçue",
    );
  }

  if (isOwner) {
    const handled = await handleOwnerCommand(jid, text);
    if (handled) return;
  }

  // 3. Pause
  if (paused) {
    logger.debug({ jid }, "[Bot] Paused — message ignored");
    return;
  }

  // 4. Rate limit
  if (isRateLimited(jid)) return;

  // 5. Commandes publiques
  if (await handlePublicCommand(jid, text)) return;

  // 6. Contact spécial
  const isWife = !!(env.bot.wifeJid && jid === env.bot.wifeJid);

  // 7. Transcription vocal
  const wasVoiceMessage = !!audioBuffer;
  let finalText = text;
  let detectedLanguage = "french"; // défaut

  if (audioBuffer) {
    logger.info({ jid }, "[Bot] Transcribing audio...");
    const result = await transcribeAudio(audioBuffer, audioMime);

    if (result?.text) {
      finalText = `[Vocal] ${result.text}`;
      detectedLanguage = result.language || "french";
      logger.info(
        { jid, language: detectedLanguage, text: result.text },
        "[Bot] Audio transcribed",
      );
    } else {
      await sendMessage(
        jid,
        "Reçu, je regarde ça dès que je peux 👍",
        env.bot.typingDelayMs,
      );
      return;
    }
  }

  if (!finalText) return;

  // 8. Ignorer messages de clôture (texte uniquement, pas les vocaux)
  if (!wasVoiceMessage && isClosingMessage(finalText)) {
    logger.debug({ jid, finalText }, "[Bot] Closing message — no reply");
    return;
  }

  try {
    await saveMessage(jid, "user", finalText, contactName);
    const history = await getHistory(jid);
    const prompt = buildPrompt(
      history,
      finalText,
      isWife,
      contactName,
      detectedLanguage,
    );

    logger.debug(
      { jid, isWife, historyLength: history.length },
      "[Bot] Sending to AI",
    );

    const reply = await askGemini(prompt);
    await saveMessage(jid, "ai", reply);

    // 9. Répondre en vocal si message vocal reçu
    if (wasVoiceMessage) {
      logger.info(
        { jid, language: detectedLanguage },
        "[Bot] Generating voice reply...",
      );
      const audioReply = await textToSpeech(reply, detectedLanguage);
      if (audioReply) {
        await sendVoiceMessage(jid, audioReply, env.bot.typingDelayMs);
        logger.info({ jid }, "[Bot] Voice reply sent ✓");
        return;
      }
      // TTS échoué — fallback texte
      logger.warn({ jid }, "[Bot] TTS failed — falling back to text");
    }

    await sendMessage(jid, reply, env.bot.typingDelayMs);
    logger.info({ jid, contactName, isWife }, "[Bot] Reply sent ✓");
  } catch (err) {
    logger.error({ err, jid }, "[Bot] Failed to handle message");
  }
}

async function handleOwnerCommand(jid, text) {
  const cmd = text?.trim().replace(/\s+/g, " ").toLowerCase();
  if (!cmd) return false;

  if (cmd === "!pause") {
    paused = true;
    await sendMessage(
      jid,
      "⏸ Bot en pause. Je prends la main.\nEnvoie !resume pour réactiver.",
    );
    logger.info("[Bot] Bot mis en pause par owner");
    return true;
  }

  if (cmd === "!resume") {
    paused = false;
    await sendMessage(jid, "▶️ Bot réactivé.");
    logger.info("[Bot] Bot réactivé par owner");
    return true;
  }

  if (cmd === "!status") {
    const uptimeMin = Math.floor(process.uptime() / 60);
    await sendMessage(
      jid,
      [
        `État : ${paused ? "⏸ en pause" : "▶️ actif"}`,
        `Uptime : ${uptimeMin} min`,
        `Réponse vocale auto : ✅ activée sur vocaux reçus`,
        `Owner JID : ${env.bot.ownerJid ?? "non défini"}`,
      ].join("\n"),
    );
    return true;
  }

  // Pause temporaire : !pause 30
  const pauseMatch = cmd.match(/^!pause (\d+)$/);
  if (pauseMatch) {
    const minutes = parseInt(pauseMatch[1], 10);
    paused = true;
    await sendMessage(
      jid,
      `⏸ Bot en pause pendant ${minutes} min. Reprise automatique ensuite.`,
    );
    logger.info({ minutes }, "[Bot] Pause temporaire activée");
    setTimeout(
      () => {
        paused = false;
        logger.info("[Bot] Pause temporaire terminée — bot réactivé");
        sendMessage(jid, "▶️ Pause terminée, bot réactivé automatiquement.");
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
