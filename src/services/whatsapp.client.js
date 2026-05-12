import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { logger } from "../config/logger.js";

let sock = null;

/**
 * Starts the WhatsApp client
 * @param {Function} onMessage - called with (sock, jid, text, contactName)
 */
export async function startWhatsApp(onMessage) {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, "[WA] Baileys version");

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger: logger.child({ module: "baileys" }),
    // Reduce noise from Baileys internal logs
    browser: ["WhatsApp AI Bot", "Chrome", "1.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // Save credentials whenever updated
  sock.ev.on("creds.update", saveCreds);

  // Handle connection state changes
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(
        "\n📱 Scanne ce QR avec WhatsApp → Appareils connectés → Connecter un appareil\n",
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      logger.info("[WA] Connected to WhatsApp ✓");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({ statusCode, shouldReconnect }, "[WA] Connection closed");

      if (shouldReconnect) {
        logger.info("[WA] Reconnecting in 3s...");
        setTimeout(() => startWhatsApp(onMessage), 3000);
      } else {
        logger.error("[WA] Logged out. Delete /auth folder and restart.");
        process.exit(1);
      }
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      await handleRawMessage(sock, msg, onMessage);
    }
  });

  return sock;
}

/**
 * Extracts text + metadata from a raw Baileys message
 */
async function handleRawMessage(sock, msg, onMessage) {
  // Ignore our own messages
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  // Extract text from different message types
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    null;

  // Ignore non-text messages (voice, stickers, etc.)
  if (!text || text.trim() === "") return;

  // Extract contact name if available
  const contactName = msg.pushName || msg.verifiedBizName || null;

  logger.debug({ jid, contactName, text }, "[WA] Incoming message");

  await onMessage(sock, jid, text.trim(), contactName, msg.messageTimestamp);
}

/**
 * Send a text message with optional typing indicator
 * @param {string} jid
 * @param {string} text
 * @param {number} delayMs
 */
export async function sendMessage(jid, text, delayMs = 0) {
  if (!sock) throw new Error("WhatsApp client not initialized");

  if (delayMs > 0) {
    // Simulate typing
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((r) => setTimeout(r, delayMs));
    await sock.sendPresenceUpdate("paused", jid);
  }

  await sock.sendMessage(jid, { text });
  logger.debug({ jid }, "[WA] Message sent");
}
