import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { useMongoAuthState } from "../helpers/mongo-auth.js";
import { logger } from "../config/logger.js";
import QRCode from "qrcode";

let sock = null;
let currentQR = null;
let isConnected = false;

export function getCurrentQR() {
  return currentQR;
}
export function getConnectionStatus() {
  return isConnected;
}

export async function startWhatsApp(onMessage) {
  // MongoDB auth — survit aux redémarrages Railway
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
      logger.info(
        "[WA] QR ready — ouvre /api/qr dans ton navigateur pour scanner",
      );
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

      logger.warn({ statusCode, shouldReconnect }, "[WA] Connection closed");

      if (shouldReconnect) {
        logger.info("[WA] Reconnecting in 3s...");
        setTimeout(() => startWhatsApp(onMessage), 3000);
      } else {
        logger.error("[WA] Logged out. Delete auth from MongoDB and restart.");
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

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    null;

  if (!text || text.trim() === "") return;

  const contactName = msg.pushName || msg.verifiedBizName || null;

  logger.debug({ jid, contactName, text }, "[WA] Incoming message");

  await onMessage(sock, jid, text.trim(), contactName, msg.messageTimestamp);
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
