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
      logger.warn({ statusCode }, "[WA] Connection closed");
      if (shouldReconnect) {
        logger.info("[WA] Reconnecting in 3s...");
        setTimeout(() => startWhatsApp(onMessage), 3000);
      } else {
        logger.error("[WA] Logged out.");
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

 
  console.log("RAW JID:", JSON.stringify(msg.key.remoteJid));
  console.log("OWNER_JID ENV:", JSON.stringify(process.env.OWNER_JID));
  
  const jid = msg.key.remoteJid;
  const contactName = msg.pushName || null;
  const messageTimestamp = msg.messageTimestamp;

  // Message texte
  const text =
    msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;

  // Message vocal (audioMessage ou pttMessage = push-to-talk)
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
        messageTimestamp,
        audioBuffer,
        mime,
      );
    } catch (err) {
      logger.error({ err }, "[WA] Failed to download audio");
      await sendMessage(jid, "Reçu, je regarde ça dès que je peux 👍");
    }
    return;
  }

  // Ignorer les non-texte (images sans caption, stickers, etc.)
  if (!text || text.trim() === "") return;

  await onMessage(
    sock,
    jid,
    text.trim(),
    contactName,
    messageTimestamp,
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
