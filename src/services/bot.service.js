import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getHistory, saveMessage } from "./memory.service.js";
import { askGemini } from "./gemini.service.js";
import { buildPrompt } from "../helpers/prompt.builder.js";
import { sendMessage } from "./whatsapp.client.js";
import { isRateLimited } from "../middleware/rateLimiter.js";
import { transcribeAudio } from "./transcription.service.js";

const BOT_START_TIME = Date.now();
let paused = false;

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

  // 1. Flood filter — ignorer les messages antérieurs au démarrage du bot
  const msgTime = (messageTimestamp || 0) * 1000;
  if (msgTime && msgTime < BOT_START_TIME - 180_000) {
    logger.debug({ jid }, "[Bot] Skipping old message");
    return;
  }

  // 2. Ignorer les groupes sauf si configuré
  if (jid.endsWith("@g.us") && !env.bot.replyGroups) return;

  // 3. Commandes owner
  // IMPORTANT : ownerJid doit être au format complet ex: "22412345678@s.whatsapp.net"
  // Vérification stricte + log pour diagnostic
  const isOwner = !!(env.bot.ownerJid && jid === env.bot.ownerJid);

  // Log systématique pour diagnostiquer les problèmes de ownerJid
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

  // 4. Pause — si le bot est en pause, ignorer tous les messages non-owner
  if (paused) {
    logger.debug({ jid }, "[Bot] Paused — message ignored");
    return;
  }

  // 5. Rate limit
  if (isRateLimited(jid)) return;

  // 6. Commandes publiques
  if (await handlePublicCommand(jid, text)) return;

  // 7. Détection contact spécial (femme)
  const isWife = !!(env.bot.wifeJid && jid === env.bot.wifeJid);

  // 8. Transcription vocal si audio
  let finalText = text;
  if (audioBuffer) {
    logger.info({ jid }, "[Bot] Transcribing audio...");
    const transcribed = await transcribeAudio(audioBuffer, audioMime);
    if (transcribed) {
      finalText = transcribed;
      logger.info({ jid, transcribed }, "[Bot] Audio transcribed");
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

  try {
    await saveMessage(jid, "user", finalText, contactName);
    const history = await getHistory(jid);
    const prompt = buildPrompt(history, finalText, isWife, contactName);

    logger.debug(
      { jid, isWife, historyLength: history.length },
      "[Bot] Sending to AI",
    );

    const reply = await askGemini(prompt);
    await saveMessage(jid, "ai", reply);
    await sendMessage(jid, reply, env.bot.typingDelayMs);

    logger.info({ jid, contactName, isWife }, "[Bot] Reply sent ✓");
  } catch (err) {
    logger.error({ err, jid }, "[Bot] Failed to handle message");
  }
}

async function handleOwnerCommand(jid, text) {
  // Nettoyage strict : trim + lowercase + suppression des espaces invisibles unicode
  const cmd = text?.trim().replace(/\s+/g, " ").toLowerCase();

  if (!cmd) return false;

  if (cmd === "!pause") {
    paused = true;
    await sendMessage(
      jid,
      `⏸ Bot en pause. Je prends la main.\nEnvoie !resume pour réactiver.`,
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
    const statusText = [
      `État : ${paused ? "⏸ en pause" : "▶️ actif"}`,
      `Uptime : ${uptimeMin} min`,
      `Owner JID : ${env.bot.ownerJid ?? "non défini"}`,
    ].join("\n");
    await sendMessage(jid, statusText);
    return true;
  }

  // Pause temporaire avec durée : !pause 30 (minutes)
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
