import { Conversation } from "../models/conversation.model.js";
import { logger } from "../config/logger.js";

// How many messages to pass to AI as context
const CONTEXT_WINDOW = 10;
// Max messages stored per conversation in DB
const MAX_STORED_MESSAGES = 50;

/**
 * Returns the last N messages for a given phone number
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
 * Saves a message (user or ai) to the conversation.
 * Uses $push + $slice to keep only the last MAX_STORED_MESSAGES in DB.
 * NOTE: $slice with $push requires the $each operator — this is intentional.
 * @param {string} phone
 * @param {"user"|"ai"} role
 * @param {string} content
 * @param {string|null} contactName
 */
export async function saveMessage(phone, role, content, contactName = null) {
  try {
    const setFields = { lastMessageAt: new Date() };
    if (contactName) {
      setFields.contactName = contactName;
    }

    await Conversation.findOneAndUpdate(
      { phone },
      {
        // $each + $slice : ajoute le message ET tronque à -MAX_STORED_MESSAGES
        // Le signe négatif garde les N derniers (les plus récents)
        $push: {
          messages: {
            $each: [{ role, content, timestamp: new Date() }],
            $slice: -MAX_STORED_MESSAGES,
          },
        },
        $inc: { totalMessages: 1 },
        $set: setFields,
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    logger.error({ err, phone, role }, "[Memory] Failed to save message");
  }
}

/**
 * Delete conversation history for a contact
 * @param {string} phone
 */
export async function clearHistory(phone) {
  await Conversation.findOneAndUpdate(
    { phone },
    { $set: { messages: [], totalMessages: 0 } },
  );
  logger.info({ phone }, "[Memory] History cleared");
}

/**
 * Returns all conversations summary (for API)
 */
export async function getAllConversations() {
  return Conversation.find()
    .select("phone contactName totalMessages lastMessageAt")
    .sort({ lastMessageAt: -1 })
    .lean();
}
