import { env } from "../config/env.js";

const CONTEXT_WINDOW = 10;

/**
 * Builds the messages array sent to the AI (OpenAI format)
 * Retourne un tableau de messages structurés plutôt qu'un bloc texte
 * @param {Array} history
 * @param {string} userMessage
 * @param {boolean} isWife
 * @param {string|null} contactName
 * @returns {{ systemExtra: string, messages: Array }}
 */
export function buildPrompt(
  history,
  userMessage,
  isWife = false,
  contactName = null,
) {
  // Contexte injecté dans le system prompt
  let systemExtra = "";

  if (isWife) {
    systemExtra = `\nATTENTION : Ce message vient de ta femme ${env.bot.wifeName}. Réponds de façon tendre et affectueuse. Tu peux l'appeler "chérie", "Sara", "mon amour" selon le contexte.`;
  } else if (contactName) {
    systemExtra = `\nLa personne qui t'écrit s'appelle ${contactName}.`;
  }

  // Historique en format messages structurés
  const historyMessages = history.slice(-CONTEXT_WINDOW).map((msg) => ({
    role: msg.role === "ai" ? "assistant" : "user",
    content: msg.content,
  }));

  // Message actuel
  historyMessages.push({
    role: "user",
    content: userMessage,
  });

  return { systemExtra, messages: historyMessages };
}
