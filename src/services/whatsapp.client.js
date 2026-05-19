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

/**
 * Ignore messages sent before bot startup
 */
const BOT_START_TIME = Math.floor(Date.now() / 1000);

/**
 * Prevent duplicate processing
 */
const processedMessages = new Set();

/**
 * Maximum accepted audio size
 * 15 MB
 */
const MAX_AUDIO_SIZE = 15 * 1024 * 1024;

export function getCurrentQR() {
  return currentQR;
}

export function getConnectionStatus() {
  return isConnected;
}

/**
 * Start WhatsApp client
 */
export async function startWhatsApp(onMessage) {
  const { state, saveCreds } = await useMongoAuthState();

  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, "[WA] Baileys version loaded");

  sock = makeWASocket({
    version,

    auth: {
      creds: state.creds,

      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },

    logger: logger.child({
      module: "baileys",
    }),

    browser: ["WhatsApp AI Bot", "Chrome", "1.0"],

    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  /**
   * Persist auth updates
   */
  sock.ev.on("creds.update", saveCreds);

  /**
   * Connection lifecycle
   */
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      isConnected = false;

      logger.info("[WA] QR ready — scan from /api/qr");
    }

    if (connection === "open") {
      currentQR = null;
      isConnected = true;

      logger.info("[WA] Connected successfully ✓");
    }

    if (connection === "close") {
      isConnected = false;

      const statusCode = lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({ statusCode }, "[WA] Connection closed");

      if (shouldReconnect) {
        logger.info("[WA] Reconnecting in 3 seconds...");

        setTimeout(() => {
          startWhatsApp(onMessage);
        }, 3000);
      } else {
        logger.error("[WA] Logged out permanently");

        process.exit(1);
      }
    }
  });

  /**
   * Incoming messages
   */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleRawMessage(sock, msg, onMessage);
      } catch (err) {
        logger.error(
          {
            err: err.message,
            stack: err.stack,
          },
          "[WA] Message processing failed",
        );
      }
    }
  });

  return sock;
}

/**
 * Core message processor
 */
async function handleRawMessage(sock, msg, onMessage) {
  if (!msg.message) return;

  if (msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  /**
   * Optional:
   * Ignore groups
   */
  const isGroup = jid.endsWith("@g.us");

  if (isGroup) {
    logger.debug({ jid }, "[WA] Ignoring group message");

    return;
  }

  /**
   * Duplicate protection
   */
  if (processedMessages.has(msg.key.id)) {
    logger.debug({ id: msg.key.id }, "[WA] Duplicate message skipped");

    return;
  }

  processedMessages.add(msg.key.id);

  /**
   * Prevent memory leak
   */
  if (processedMessages.size > 5000) {
    processedMessages.clear();
  }

  const msgTimestamp = Number(msg.messageTimestamp) || 0;

  /**
   * Ignore old messages
   */
  if (msgTimestamp < BOT_START_TIME) {
    logger.debug(
      {
        jid,
        msgTimestamp,
        BOT_START_TIME,
      },
      "[WA] Ignoring pre-boot message",
    );

    return;
  }

  const contactName = msg.pushName || null;

  /**
   * Mark as read
   */
  await sock.readMessages([msg.key]);

  /**
   * Text extraction
   */
  const text =
    msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;

  /**
   * Audio detection
   */
  const audioMessage = msg.message?.audioMessage;

  const isAudio = !!audioMessage;

  /**
   * AUDIO FLOW
   */
  if (isAudio) {
    logger.info({ jid }, "[WA] Audio message received");

    /**
     * Typing/recording indicator
     */
    await sock.sendPresenceUpdate("recording", jid);

    /**
     * Audio size protection
     */
    const fileLength = Number(audioMessage?.fileLength) || 0;

    if (fileLength > MAX_AUDIO_SIZE) {
      await sendMessage(jid, "Votre message vocal est trop long.");

      return;
    }

    try {
      /**
       * Download voice/audio
       */
      const audioBuffer = await downloadMediaMessage(msg, "buffer", {});

      const mime = audioMessage?.mimetype || "audio/ogg";

      /**
       * Forward to AI pipeline
       */
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
      logger.error(
        {
          err: err.message,
          stack: err.stack,
        },
        "[WA] Failed to process audio",
      );

      await sendMessage(
        jid,
        "Désolé, je n'arrive pas à traiter ce vocal actuellement.",
      );
    }

    return;
  }

  /**
   * Ignore empty messages
   */
  if (!text || text.trim() === "") {
    return;
  }

  /**
   * Forward text to AI pipeline
   */
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

/**
 * Send text message
 */
export async function sendMessage(jid, text, delayMs = 0) {
  if (!sock) {
    throw new Error("WhatsApp client not initialized");
  }

  if (!text || text.trim() === "") {
    throw new Error("Cannot send empty message");
  }

  if (delayMs > 0) {
    await sock.sendPresenceUpdate("composing", jid);

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    await sock.sendPresenceUpdate("paused", jid);
  }

  await sock.sendMessage(jid, {
    text,
  });

  logger.info({ jid }, "[WA] Text message sent");
}

/**
 * Send WhatsApp-native voice note
 * OGG Opus + PTT
 */
export async function sendVoiceMessage(jid, audioBuffer, delayMs = 0) {
  if (!sock) {
    throw new Error("WhatsApp client not initialized");
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error("Invalid audio buffer");
  }

  if (delayMs > 0) {
    await sock.sendPresenceUpdate("recording", jid);

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    await sock.sendPresenceUpdate("paused", jid);
  }

  await sock.sendMessage(jid, {
    audio: audioBuffer,

    mimetype: "audio/ogg; codecs=opus",

    ptt: true,
  });

  logger.info({ jid }, "[WA] Voice note sent");
}
