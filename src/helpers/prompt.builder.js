import { env } from "../config/env.js";

const CONTEXT_WINDOW = 10;

/**
 * Builds the full prompt sent to the AI
 * @param {Array} history
 * @param {string} userMessage
 * @param {boolean} isWife
 * @param {string|null} contactName
 * @returns {string}
 */
export function buildPrompt(
  history,
  userMessage,
  isWife = false,
  contactName = null,
) {
  const context = history
    .slice(-CONTEXT_WINDOW)
    .map((msg) => `${msg.role === "user" ? "Ami" : "Moi"}: ${msg.content}`)
    .join("\n");

  // Injection du contexte spécial si c'est Sara
  const wifeContext = isWife
    ? `\n⚠️ IMPORTANT : Ce message vient de ta femme ${env.bot.wifeName} (Sarata Condé). 
Réponds de façon tendre, affectueuse et intime. 
Tu peux l'appeler "chérie", "Sara", "mon amour" selon le contexte.
Sois attentionné, doux, présent. C'est ta femme — traite-la différemment des autres contacts.\n`
    : "";

  const nameContext =
    contactName && !isWife
      ? `\nLa personne qui t'écrit s'appelle ${contactName}. Tu peux utiliser son prénom naturellement dans la conversation.\n`
      : "";

  return `${wifeContext}${nameContext}${context ? `Historique de la conversation:\n${context}\n` : ""}
Ami: ${userMessage}
Moi:`.trim();
}
