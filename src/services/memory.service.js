import { Conversation } from "../models/conversation.model.js";
import { logger } from "../config/logger.js";

// Nombre de messages à passer à l'IA comme contexte
const CONTEXT_WINDOW = 15; // Aligné avec ton prompt builder pour un meilleur fil conducteur
// Max messages stockés par conversation dans la DB
const MAX_STORED_MESSAGES = 50;

/**
 * Retourne les derniers N messages pour un numéro donné
 * @param {string} phone - WhatsApp JID
 * @returns {Promise<Array>}
 */
export async function getHistory(phone) {
  try {
    const convo = await Conversation.findOne({ phone }).lean();
    return convo?.messages?.slice(-CONTEXT_WINDOW) || [];
  } catch (err) {
    logger.error({ err, phone }, "[Memory] Failed to get history");
    return [];
  }
}

/**
 * Enregistre un message (user ou ai) dans la conversation.
 * Évite les écritures miroirs identiques successives.
 * @param {string} phone
 * @param {"user"|"ai"} role
 * @param {string} content
 * @param {string|null} contactName
 */
export async function saveMessage(phone, role, content, contactName = null) {
  try {
    const cleanContent = content?.trim();
    if (!cleanContent) return;

    // PROTECTION ANTI-DOUBLON HISTORIQUE :
    // On vérifie le tout dernier message en DB pour ce fil
    const existingConvo = await Conversation.findOne(
      { phone },
      { messages: { $slice: -1 } },
    ).lean();
    const lastMessage = existingConvo?.messages?.[0];

    if (
      lastMessage &&
      lastMessage.role === role &&
      lastMessage.content === cleanContent
    ) {
      logger.debug(
        { phone, role },
        "[Memory] Message identique déjà présent à la fin de l'historique. Skip.",
      );
      return;
    }

    const setFields = { lastMessageAt: new Date() };
    if (contactName) {
      setFields.contactName = contactName;
    }

    await Conversation.findOneAndUpdate(
      { phone },
      {
        $push: {
          messages: {
            $each: [{ role, content: cleanContent, timestamp: new Date() }],
            $slice: -MAX_STORED_MESSAGES,
          },
        },
        $inc: { totalMessages: 1 },
        $set: setFields,
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    logger.error(
      { err: err.message, phone, role },
      "[Memory] Failed to save message",
    );
  }
}

/**
 * Supprime l'historique des messages d'un contact
 * @param {string} phone
 */
export async function clearHistory(phone) {
  try {
    await Conversation.findOneAndUpdate(
      { phone },
      { $set: { messages: [], totalMessages: 0 } },
    );
    logger.info({ phone }, "[Memory] History cleared");
  } catch (err) {
    logger.error(
      { err: err.message, phone },
      "[Memory] Failed to clear history",
    );
  }
}

/**
 * Retourne le résumé de toutes les conversations (pour ton Dashboard API)
 */
export async function getAllConversations() {
  try {
    return await Conversation.find()
      .select("phone contactName totalMessages lastMessageAt")
      .sort({ lastMessageAt: -1 })
      .lean();
  } catch (err) {
    logger.error(
      { err: err.message },
      "[Memory] Failed to get all conversations",
    );
    return [];
  }
}
