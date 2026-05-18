import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { useMongoAuthState } from "../helpers/mongo-auth.js";
import { logger } from "../config/logger.js";

let sock = null;
let currentQR = null;
let isConnected = false;

const BOT_START_TIME = Math.floor(Date.now() / 1000);

export function getCurrentQR() {
  return currentQR;
}

export function getConnectionStatus() {
  return isConnected;
}

export async function startWhatsApp(onMessage) {
  const { state, saveCreds } = await useMongoAuthState();
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "[WA] Baileys version");

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger: logger.child({ module: "baileys" }),
    browser: ["WhatsApp AI Bot", "Chrome", "1.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      isConnected = false;
      logger.info("[WA] QR ready — Open /api/qr in your browser to scan");
    }

    if (connection === "open") {
      currentQR = null;
      isConnected = true;
      logger.info("[WA] Connected to WhatsApp ✓");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({ statusCode }, "[WA] Connection closed");

      if (shouldReconnect) {
        logger.info("[WA] Reconnecting in 3s...");
        setTimeout(() => startWhatsApp(onMessage), 3000);
      } else {
        logger.error("[WA] Logged out permanently.");
        process.exit(1);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      await handleRawMessage(sock, msg, onMessage);
    }
  });

  return sock;
}

async function handleRawMessage(sock, msg, onMessage) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  const msgTimestamp = msg.messageTimestamp || 0;

  if (msgTimestamp < BOT_START_TIME) {
    logger.debug(
      { jid, msgTimestamp, BOT_START_TIME },
      "[WA] Skipping pre-boot message",
    );
    return;
  }

  const contactName = msg.pushName || null;

  const text =
    msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;

  const isAudio = !!msg.message?.audioMessage || !!msg.message?.pttMessage;

  if (isAudio) {
    logger.info({ jid }, "[WA] Audio message received — downloading...");
    try {
      const audioBuffer = await downloadMediaMessage(msg, "buffer", {});
      const mime =
        msg.message?.audioMessage?.mimetype ||
        msg.message?.pttMessage?.mimetype ||
        "audio/ogg";
      await onMessage(
        sock,
        jid,
        null,
        contactName,
        msgTimestamp,
        audioBuffer,
        mime,
      );
    } catch (err) {
      logger.error({ err }, "[WA] Failed to download audio");
      await sock
        .sendMessage(jid, { text: "Reçu, je regarde ça dès que je peux 👍" })
        .catch((e) => {
          logger.error({ e }, "[WA] Fallback message failed");
        });
    }
    return;
  }

  if (!text || text.trim() === "") return;

  await onMessage(
    sock,
    jid,
    text.trim(),
    contactName,
    msgTimestamp,
    null,
    null,
  );
}

export async function sendMessage(jid, text, delayMs = 0) {
  if (!sock) throw new Error("WhatsApp client not initialized");

  if (delayMs > 0) {
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((r) => setTimeout(r, delayMs));
    await sock.sendPresenceUpdate("paused", jid);
  }

  await sock.sendMessage(jid, { text });
  logger.debug({ jid }, "[WA] Message sent");
}

/**
 * Envoie un vocal WhatsApp (PTT) depuis un buffer OGG Opus
 * @param {string} jid
 * @param {Buffer} audioBuffer - OGG Opus buffer
 * @param {number} delayMs
 */
export async function sendVoiceMessage(jid, audioBuffer, delayMs = 0) {
  if (!sock) throw new Error("WhatsApp client not initialized");

  if (delayMs > 0) {
    await sock.sendPresenceUpdate("recording", jid);
    await new Promise((r) => setTimeout(r, delayMs));
    await sock.sendPresenceUpdate("paused", jid);
  }

  await sock.sendMessage(jid, {
    audio: audioBuffer,
    mimetype: "audio/ogg; codecs=opus", // ← format exact requis par WhatsApp PTT
    ptt: true,
  });

  logger.debug({ jid }, "[WA] Voice message sent");
}
