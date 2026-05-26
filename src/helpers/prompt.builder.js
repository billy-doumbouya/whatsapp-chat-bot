import { env } from "../config/env.js";
import { Bio } from "../data/bio.js";

const CONTEXT_WINDOW = 10;

/**
 * Normalise la langue reçue de Whisper ou de l'analyse textuelle
 * @param {string|null} lang
 * @returns {"anglais"|"français"|"malinké"}
 */
function normalizeLanguage(lang) {
  if (!lang) return null;
  const lower = lang.toLowerCase().trim();
  if (lower.startsWith("en") || lower.includes("english")) return "anglais";
  if (
    lower.includes("malinke") ||
    lower.includes("maninka") ||
    lower.includes("bambara")
  )
    return "malinké";
  return "français";
}

/**
 * Construit le tableau de messages final destiné à l'API LLM (Gemini/OpenAI)
 *
 * @param {Array} history - L'historique extrait de la base MongoDB
 * @param {string} userMessage - Le dernier message reçu (ou la transcription Whisper)
 * @param {boolean} isWife - Flag indiquant si l'interlocuteur est Sara
 * @param {string|null} contactName - Le nom enregistré du contact WhatsApp
 * @param {string|null} detectedLanguage - La langue détectée par le service de transcription
 * @returns {Array} Payload de messages prêt pour l'envoi
 */
export function buildPrompt(
  history,
  userMessage,
  isWife = false,
  contactName = null,
  detectedLanguage = null,
) {
  let system = Bio;

  if (isWife) {
    system += `\n\nCONTEXT: Sara is your partner. Use affectionate tone.`;
  }

  if (contactName) {
    system += `\n\nCONTEXT: User name is ${contactName}.`;
  }

  const messages = [
    { role: "system", content: system },
    ...history.slice(-CONTEXT_WINDOW).map((m) => ({
      role: m.role === "ai" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  let finalUserMessage = userMessage;

  if (detectedLanguage) {
    finalUserMessage += `\n\nRespond in: ${detectedLanguage}`;
  }

  messages.push({
    role: "user",
    content: finalUserMessage,
  });

  return messages;
}
