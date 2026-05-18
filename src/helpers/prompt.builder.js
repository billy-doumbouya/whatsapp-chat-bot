import { env } from "../config/env.js";

const CONTEXT_WINDOW = 10;

/**
 * Builds the messages array sent to the AI (OpenAI format)
 * @param {Array} history
 * @param {string} userMessage
 * @param {boolean} isWife
 * @param {string|null} contactName
 * @param {string} detectedLanguage - langue détectée par Whisper ex: "french", "english"
 * @returns {{ systemExtra: string, messages: Array }}
 */
export function buildPrompt(
  history,
  userMessage,
  isWife = false,
  contactName = null,
  detectedLanguage = null,
) {
  let systemExtra = "";

  if (isWife) {
    systemExtra = `\nATTENTION : Ce message vient de ta femme ${env.bot.wifeName}. Réponds de façon tendre et affectueuse. Tu peux l'appeler "chérie", "Sara", "mon amour" selon le contexte.`;
  } else if (contactName) {
    systemExtra = `\nLa personne qui t'écrit s'appelle ${contactName}.`;
  }

  // Historique structuré
  const historyMessages = history.slice(-CONTEXT_WINDOW).map((msg) => ({
    role: msg.role === "ai" ? "assistant" : "user",
    content: msg.content,
  }));

  // Instruction langue collée au message — Gemini ne peut pas l'ignorer
  const langInstruction = detectedLanguage
    ? `\n\n[Réponds obligatoirement en ${detectedLanguage === "english" ? "anglais" : "français"}]`
    : "\n\n[Réponds obligatoirement dans la même langue que ce message]";

  historyMessages.push({
    role: "user",
    content: userMessage + langInstruction,
  });

  return { systemExtra, messages: historyMessages };
}
