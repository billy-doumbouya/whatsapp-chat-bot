import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

import { useMongoAuthState } from "../helpers/mongo-auth.js";
import { logger } from "../config/logger.js";
import { onHumanReply } from "../services/bot.service.js"; // Import indispensable pour la mémoire contextuelle

let sock = null;
let currentQR = null;
let isConnected = false;

/**
 * Ignore les messages envoyés avant le démarrage du bot
 */
const BOT_START_TIME = Math.floor(Date.now() / 1000);

/**
 * Évite le double traitement des messages (Cache anti-doublon)
 */
const processedMessages = new Set();

/**
 * Taille maximale acceptée pour un fichier audio (15 Mo)
 */
const MAX_AUDIO_SIZE = 15 * 1024 * 1024;

export function getCurrentQR() {
  return currentQR;
}

export function getConnectionStatus() {
  return isConnected;
}

/**
 * Démarre le client WhatsApp
 */
export async function startWhatsApp({ onIncomingMessage, onHumanReply }) {
  const { state, saveCreds } = await useMongoAuthState();
  const { version } = await fetchLatestBaileysVersion();

  logger.info({ version }, "[WA] Baileys version loaded");

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

  /**
   * Persistance des mises à jour d'authentification
   */
  sock.ev.on("creds.update", saveCreds);

  /**
   * Cycle de vie de la connexion
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
          startWhatsApp({ onIncomingMessage, onHumanReply });
        }, 3000);
      } else {
        logger.error("[WA] Logged out permanently");
        process.exit(1);
      }
    }
  });

  /**
   * Réception des messages entrants et sortants
   */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleRawMessage(sock, msg, onIncomingMessage);
      } catch (err) {
        logger.error(
          { err: err.message, stack: err.stack },
          "[WA] Message processing failed",
        );
      }
    }
  });

  return sock;
}

/**
 * Processeur central des messages bruts WhatsApp
 */
async function handleRawMessage(sock, msg, onIncomingMessage) {
  if (!msg.message) return;

  const jid = msg.key.remoteJid;

  // Extraction du texte multi-format (gère conversations simples, messages enrichis et légendes de médias)
  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null;

  /**
   * CAPTURE DE TA PROPRE ACTIVITÉ (MANUELLE)
   * Si le message vient de toi, on extrait le texte et on l'enregistre dans Mongo pour l'historique du bot.
   */
  if (msg.key.fromMe) {
    if (text && text.trim() !== "") {
      // Déclenche l'enregistrement en tâche de fond pour l'IA
      await onHumanReply(jid, text.trim());
    }
    return; // On s'arrête ici, le bot ne doit pas se répondre à lui-même
  }

  /**
   * Protection contre les doublons
   */
  if (processedMessages.has(msg.key.id)) {
    logger.debug({ id: msg.key.id }, "[WA] Duplicate message skipped");
    return;
  }
  processedMessages.add(msg.key.id);

  // Nettoyage périodique pour éviter les fuites de mémoire
  if (processedMessages.size > 5000) {
    processedMessages.clear();
  }

  const msgTimestamp = Number(msg.messageTimestamp) || 0;

  /**
   * Ignore les anciens messages (reçus pendant que le serveur était éteint)
   */
  if (msgTimestamp < BOT_START_TIME) {
    logger.debug(
      { jid, msgTimestamp, BOT_START_TIME },
      "[WA] Ignoring pre-boot message",
    );
    return;
  }

  const contactName = msg.pushName || null;

  /**
   * Marquer le message comme lu immédiatement
   */
  await sock.readMessages([msg.key]);

  /**
   * Détection et traitement des messages Audio / Vocaux
   */
  const audioMessage = msg.message?.audioMessage;
  const isAudio = !!audioMessage;

  if (isAudio) {
    logger.info({ jid }, "[WA] Audio message received");

    // Déclenche l'indicateur "Enregistre un audio..." sur le téléphone de l'émetteur
    await sock.sendPresenceUpdate("recording", jid);

    const fileLength = Number(audioMessage?.fileLength) || 0;
    if (fileLength > MAX_AUDIO_SIZE) {
      await sendMessage(
        sock,
        jid,
        "Votre message vocal est trop long (limite de 15 Mo).",
      );
      return;
    }

    try {
      // Téléchargement du buffer du message vocal
      const audioBuffer = await downloadMediaMessage(msg, "buffer", {});
      const mime = audioMessage?.mimetype || "audio/ogg";

      // Transmission au pipeline d'orchestration de l'IA
      await onIncomingMessage(
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
        { err: err.message, stack: err.stack },
        "[WA] Failed to process audio media download",
      );

      await sendMessage(
        jid,
        "Désolé, je n'arrive pas à télécharger ou lire ce vocal actuellement. Peux-tu reformuler par écrit ?",
      );
    }
    return;
  }

  /**
   * Ignore les messages textuels vides
   */
  if (!text || text.trim() === "") {
    return;
  }

  /**
   * Envoi du texte propre au pipeline d'orchestration de l'IA
   */
  await onIncomingMessage(
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
 * Envoie un message textuel avec simulation d'écriture
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

  await sock.sendMessage(jid, { text });
  logger.info({ jid }, "[WA] Text message sent");
}

/**
 * Envoie une note vocale native WhatsApp (OGG/Opus + indicateur PTT)
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
    ptt: true, // Affiche le lecteur comme un enregistrement de note vocale classique
  });

  logger.info({ jid }, "[WA] Voice note sent");
}
