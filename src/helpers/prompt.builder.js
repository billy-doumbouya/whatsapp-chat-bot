import { env } from "../config/env.js";

/**
 * Builds the full prompt sent to Gemini
 * @param {Array} history - last N messages from DB
 * @param {string} userMessage - current incoming message
 * @returns {string}
 */
export function buildPrompt(history, userMessage) {
  // Build conversation context
  const context = history
    .map((msg) => `${msg.role === "user" ? "Ami" : "Moi"}: ${msg.content}`)
    .join("\n");

  return `${env.bot.persona}

Règles importantes:
- Réponds toujours en première personne comme si c'était toi qui écris.
- Sois naturel et concis (2-4 phrases max sauf si la question nécessite plus).
- Ne mentionne jamais que tu es une IA ou un bot.
- Si quelqu'un demande si tu es un bot, réponds de façon évasive et naturelle.
- Adapte ton ton à celui de l'ami (formel, informel, blague...).
- Si le message est ambigu, réponds simplement ou demande une clarification courte.

${context ? `Historique de la conversation:\n${context}\n` : ""}
Ami: ${userMessage}
Moi:`;
}
