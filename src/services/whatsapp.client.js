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

// Ignore les messages antérieurs au démarrage du bot
const BOT_START_TIME = Math.floor(Date.now() / 1000);

// FIX Bug 2: LRU manuel — on ne clear() plus tout le Set d'un coup.
// On garde les 500 derniers IDs dans un tableau tournant pour éviter
// de perdre les IDs récents lors d'un burst de messages.
const MAX_PROCESSED_IDS = 500;
const processedIds = new Set();
const processedIdsQueue = [];

function markProcessed(id) {
  if (processedIds.has(id)) return false;
  processedIds.add(id);
  processedIdsQueue.push(id);
  if (processedIdsQueue.length > MAX_PROCESSED_IDS) {
    const oldest = processedIdsQueue.shift();
    processedIds.delete(oldest);
  }
  return true;
}

// Taille maximale pour un fichier audio (15 Mo)
const MAX_AUDIO_SIZE = 15 * 1024 * 1024;

// FIX Bug 3: Backoff exponentiel pour la reconnexion (max 30s)
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 30_000;

function getReconnectDelay() {
  const delay = Math.min(
    3000 * Math.pow(1.5, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectAttempts++;
  return delay;
}

export function getCurrentQR() {
  return currentQR;
}

export function getConnectionStatus() {
  return isConnected;
}

/**
 * Démarre le client WhatsApp.
 *
 * FIX Bug 4: Le paramètre `onHumanReply` rentrait en collision avec
 * l'import du même nom depuis bot.service.js. Les deux fonctions
 * coexistaient dans le même scope → comportement indéfini selon
 * l'ordre d'exécution.
 * Solution : on supprime l'import statique de onHumanReply depuis
 * bot.service.js et on reçoit uniquement la référence via paramètre.
 *
 * @param {{ onIncomingMessage: Function, onHumanReply: Function }} callbacks
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

    // FIX "unexpected error in 'init queries'" sur Railway :
    // Railway ajoute de la latence réseau vers les serveurs WhatsApp.
    // defaultQueryTimeoutMs à 20s est trop court — on monte à 60s.
    // fireInitQueries: false évite que Baileys bloque sur des requêtes
    // d'init non-critiques (contacts, groupes) qui timeout sur les
    // environnements cloud avec latence élevée.
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    fireInitQueries: false,

    // Retry automatique des messages si WhatsApp demande un renvoi
    retryRequestDelayMs: 2_000,
  });

  // Persistance des mises à jour d'authentification
  sock.ev.on("creds.update", saveCreds);

  // Cycle de vie de la connexion
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      isConnected = false;
      logger.info("[WA] QR ready — scan from /api/qr");
    }

    if (connection === "open") {
      currentQR = null;
      isConnected = true;
      reconnectAttempts = 0; // Réinitialise le compteur de backoff
      logger.info("[WA] Connected successfully ✓");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn({ statusCode }, "[WA] Connection closed");

      if (shouldReconnect) {
        const delay = getReconnectDelay();
        logger.info(
          { delay, attempt: reconnectAttempts },
          "[WA] Reconnecting...",
        );
        setTimeout(() => {
          startWhatsApp({ onIncomingMessage, onHumanReply });
        }, delay);
      } else {
        logger.error("[WA] Logged out permanently");
        process.exit(1);
      }
    }
  });

  // Réception des messages entrants et sortants
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleRawMessage(sock, msg, onIncomingMessage, onHumanReply);
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
 * Processeur central des messages bruts WhatsApp.
 */
async function handleRawMessage(sock, msg, onIncomingMessage, onHumanReply) {
  if (!msg.message) return;

  const jid = msg.key.remoteJid;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    null;

  // Capture des messages envoyés manuellement par l'owner
  if (msg.key.fromMe) {
    if (text?.trim()) {
      await onHumanReply(jid, text.trim());
    }
    return;
  }

  // FIX Bug 2: LRU anti-doublon au lieu de clear() brutal
  if (!markProcessed(msg.key.id)) {
    logger.debug({ id: msg.key.id }, "[WA] Duplicate message skipped");
    return;
  }

  const msgTimestamp = Number(msg.messageTimestamp) || 0;

  // Ignore les messages antérieurs au démarrage
  if (msgTimestamp < BOT_START_TIME) {
    logger.debug({ jid, msgTimestamp }, "[WA] Ignoring pre-boot message");
    return;
  }

  const contactName = msg.pushName || null;

  const audioMessage = msg.message?.audioMessage;
  const isAudio = !!audioMessage;

  if (isAudio) {
    logger.info({ jid }, "[WA] Audio message received");
    await sock.sendPresenceUpdate("recording", jid);

    const fileLength = Number(audioMessage?.fileLength) || 0;
    if (fileLength > MAX_AUDIO_SIZE) {
      await sendMessage(
        jid,
        "Votre message vocal est trop long (limite 15 Mo).",
      );
      return;
    }

    try {
      const audioBuffer = await downloadMediaMessage(msg, "buffer", {});
      const mime = audioMessage?.mimetype || "audio/ogg";

      // FIX Bug 5: readMessages déclenché APRÈS le traitement réussi
      await onIncomingMessage(
        sock,
        jid,
        null,
        contactName,
        msgTimestamp,
        audioBuffer,
        mime,
      );

      await sock.readMessages([msg.key]);
    } catch (err) {
      logger.error(
        { err: err.message, stack: err.stack },
        "[WA] Failed to process audio",
      );
      await sendMessage(
        jid,
        "Désolé, je n'arrive pas à lire ce vocal. Peux-tu reformuler par écrit ?",
      );
    }
    return;
  }

  if (!text?.trim()) return;

  // FIX Bug 5: readMessages déclenché APRÈS le traitement réussi
  await onIncomingMessage(
    sock,
    jid,
    text.trim(),
    contactName,
    msgTimestamp,
    null,
    null,
  );

  await sock.readMessages([msg.key]);
}

/**
 * Envoie un message texte avec simulation de frappe.
 */
export async function sendMessage(jid, text, delayMs = 0) {
  if (!sock) throw new Error("WhatsApp client not initialized");
  if (!text?.trim()) throw new Error("Cannot send empty message");

  if (delayMs > 0) {
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await sock.sendPresenceUpdate("paused", jid);
  }

  await sock.sendMessage(jid, { text });
  logger.info({ jid }, "[WA] Text message sent");
}

/**
 * Envoie une note vocale native WhatsApp (OGG/Opus PTT).
 */
export async function sendVoiceMessage(jid, audioBuffer, delayMs = 0) {
  if (!sock) throw new Error("WhatsApp client not initialized");
  if (!audioBuffer?.length) throw new Error("Invalid audio buffer");

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
