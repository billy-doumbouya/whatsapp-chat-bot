import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getHistory, saveMessage } from "./memory.service.js";
import { askGemini } from "./gemini.service.js";
import { buildPrompt } from "../helpers/prompt.builder.js";
import { sendMessage } from "./whatsapp.client.js";
import { isRateLimited } from "../middleware/rateLimiter.js";

// Timestamp de démarrage du bot — ignore les messages antérieurs
const BOT_START_TIME = Date.now();

// Mode pause — activé/désactivé par Billy via !pause / !resume
let paused = false;

/**
 * Main message handler — bridges WhatsApp ↔ AI ↔ Memory
 */
export async function handleIncomingMessage(
  sock,
  jid,
  text,
  contactName,
  messageTimestamp,
) {
  // 1. Ignorer les messages reçus AVANT le démarrage du bot (flood offline)
  const msgTime = (messageTimestamp || 0) * 1000; // Baileys donne en secondes
  if (msgTime && msgTime < BOT_START_TIME - 180_000) {
    logger.debug(
      { jid, msgTime },
      "[Bot] Skipping old message (offline flood)",
    );
    return;
  }

  // 2. Ignorer les groupes si non configuré
  const isGroup = jid.endsWith("@g.us");
  if (isGroup && !env.bot.replyGroups) return;

  // 3. Commandes owner (numéro de Billy lui-même)
  const isOwner = env.bot.ownerJid && jid === env.bot.ownerJid;
  if (isOwner) {
    if (await handleOwnerCommand(jid, text)) return;
  }

  // 4. Bot en pause — silence total
  if (paused) {
    logger.debug({ jid }, "[Bot] Paused, skipping");
    return;
  }

  // 5. Rate limiting par contact
  if (isRateLimited(jid)) return;

  // 6. Commandes publiques (!reset)
  if (await handlePublicCommand(jid, text)) return;

  try {
    await saveMessage(jid, "user", text, contactName);
    const history = await getHistory(jid);
    const prompt = buildPrompt(history, text);

    logger.debug(
      { jid, historyLength: history.length },
      "[Bot] Sending to Gemini",
    );

    const reply = await askGemini(prompt);
    await saveMessage(jid, "ai", reply);
    await sendMessage(jid, reply, env.bot.typingDelayMs);

    logger.info({ jid, contactName }, "[Bot] Reply sent ✓");
  } catch (err) {
    logger.error({ err, jid }, "[Bot] Failed to handle message");
  }
}

// Commandes réservées à Billy (owner)
async function handleOwnerCommand(jid, text) {
  const cmd = text.trim().toLowerCase();

  if (cmd === "!pause") {
    paused = true;
    await sendMessage(jid, "⏸ Bot en pause. Envoie !resume pour réactiver.");
    logger.info("[Bot] Paused by owner");
    return true;
  }

  if (cmd === "!resume") {
    paused = false;
    await sendMessage(jid, "▶️ Bot réactivé.");
    logger.info("[Bot] Resumed by owner");
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

// Commandes accessibles à tous
async function handlePublicCommand(jid, text) {
  const cmd = text.trim().toLowerCase();

  if (cmd === "!reset") {
    const { clearHistory } = await import("./memory.service.js");
    await clearHistory(jid);
    await sendMessage(jid, "Conversation réinitialisée 👍");
    return true;
  }

  return false;
}
