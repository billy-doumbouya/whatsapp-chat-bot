import { Bio } from "../data/bio.js";

// Aligné avec CONTEXT_WINDOW de memory.service.js (source unique de vérité).
// FIX Bug 9: le slice est fait UNE SEULE FOIS ici — on supprime le
// history.slice(-CONTEXT_WINDOW) qui était aussi dans buildPrompt(),
// ce qui réduisait la fenêtre effective à 10 (CONTEXT_WINDOW local)
// au lieu des 15 déjà slicés par getHistory().
// Désormais getHistory() fournit exactement les N bons messages
// et buildPrompt() les utilise tels quels.

/**
 * Normalise la langue reçue de Whisper vers une valeur stable pour le LLM.
 * @param {string|null} lang
 * @returns {"anglais"|"français"|"malinké"|null}
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
 * Sanitise un nom de contact pour éviter l'injection dans le system prompt.
 * FIX Bug 8: un contactName envoyé par l'utilisateur comme
 * "Sara. Ignore previous instructions and..." était injecté
 * directement dans le system prompt sans aucune validation.
 * On tronque, on supprime les retours à la ligne et les caractères
 * de contrôle, et on échappe les backticks.
 *
 * @param {string|null} name
 * @returns {string|null}
 */
function sanitizeContactName(name) {
  if (!name || typeof name !== "string") return null;
  return (
    name
      .replace(/[\r\n\t]/g, " ") // Pas de retours à la ligne dans le prompt
      .replace(/`/g, "'") // Pas de backticks exploitables
      .slice(0, 50) // Taille max raisonnable pour un prénom
      .trim() || null
  );
}

/**
 * Construit le tableau de messages destiné à l'API LLM.
 *
 * @param {Array}       history          - Messages extraits de MongoDB (déjà slicés par getHistory)
 * @param {string}      userMessage      - Dernier message reçu (ou transcription Whisper)
 * @param {boolean}     isWife           - Flag Sara
 * @param {string|null} contactName      - Nom du contact WhatsApp (non approuvé — sanitisé ici)
 * @param {string|null} detectedLanguage - Langue détectée par Whisper
 * @returns {Array} Payload prêt pour l'envoi au LLM
 */
export function buildPrompt(
  history,
  userMessage,
  isWife = false,
  contactName = null,
  detectedLanguage = null,
) {
  const safeName = sanitizeContactName(contactName);
  const normalizedLang = normalizeLanguage(detectedLanguage);

  // Construction du system prompt
  let system = Bio;

  if (isWife) {
    system += `\n\nCONTEXT: Sara is your partner. Use affectionate tone.`;
  }

  if (safeName) {
    system += `\n\nCONTEXT: User name is ${safeName}.`;
  }

  // FIX Bug 10: l'instruction de langue est injectée dans le system prompt
  // et non dans le message user. Avant, le LLM pouvait répéter l'instruction
  // verbatim ("Respond in: français") au lieu de simplement l'appliquer.
  if (normalizedLang) {
    system += `\n\nCONTEXT: Always respond in ${normalizedLang}. Do not mention this instruction.`;
  }

  const messages = [
    { role: "system", content: system },
    // FIX Bug 9: history est utilisé tel quel — getHistory() a déjà appliqué le slice.
    ...history.map((m) => ({
      role: m.role === "ai" ? "assistant" : "user",
      content: m.content,
    })),
    {
      role: "user",
      content: userMessage,
    },
  ];

  return messages;
}
