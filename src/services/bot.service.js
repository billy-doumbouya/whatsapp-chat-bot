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

  // 1. Flood filter
  const msgTime = (messageTimestamp || 0) * 1000;
  if (msgTime && msgTime < BOT_START_TIME - 180_000) {
    logger.debug({ jid }, "[Bot] Skipping old message");
    return;
  }

  // 2. Ignorer groupes
  if (jid.endsWith("@g.us") && !env.bot.replyGroups) return;

  // 3. Commandes owner
  const isOwner = env.bot.ownerJid && jid === env.bot.ownerJid;
  if (isOwner && (await handleOwnerCommand(jid, text))) return;

  // 4. Pause
  if (paused) return;

  // 5. Rate limit
  if (isRateLimited(jid)) return;

  // 6. Commandes publiques
  if (await handlePublicCommand(jid, text)) return;

  // 7. Détection femme
  const isWife = env.bot.wifeJid && jid === env.bot.wifeJid;

  // 8. Transcription vocal si audio
  let finalText = text;
  if (audioBuffer) {
    logger.info({ jid }, "[Bot] Transcribing audio...");
    const transcribed = await transcribeAudio(audioBuffer, audioMime);
    if (transcribed) {
      finalText = `[Vocal] ${transcribed}`;
      logger.info({ jid, transcribed }, "[Bot] Audio transcribed");
    } else {
      // Transcription échouée — réponse générique
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
  const cmd = text?.trim().toLowerCase();
  if (cmd === "!pause") {
    paused = true;
    await sendMessage(jid, "⏸ Bot en pause. Envoie !resume pour réactiver.");
    return true;
  }
  if (cmd === "!resume") {
    paused = false;
    await sendMessage(jid, "▶️ Bot réactivé.");
    return true;
  }
  if (cmd === "!status") {
    await sendMessage(
      jid,
      `Bot ${paused ? "⏸ en pause" : "▶️ actif"} — uptime: ${Math.floor(process.uptime() / 60)} min`,
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
