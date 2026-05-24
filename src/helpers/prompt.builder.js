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
  // 1. Initialisation du prompt système avec ta Bio officielle
  let dynamicSystemInstructions = Bio;

  // 2. Ajout des couches de contexte prioritaires au prompt système
  if (isWife) {
    dynamicSystemInstructions += `\n\n---
# CRITICAL WIFE CONTEXT
Ce message vient de ta femme Sara (${env.bot.wifeName}). Applique immédiatement les règles affectueuses du persona. Tu dois l'appeler "chérie", "mon amour" ou "Sara". Ne sois jamais distant ou formel avec elle.`;
  } else if (contactName) {
    dynamicSystemInstructions += `\n\n---
# CURRENT CONTACT CONTEXT
La personne qui t'écrit actuellement s'appelle : ${contactName}. Utilise son prénom si la situation s'y prête conformément aux règles de style du persona.`;
  }

  const finalMessages = [
    {
      role: "system",
      content: dynamicSystemInstructions,
    },
  ];

  // 3. Traitement et injection de l'historique récent (Respect de la CONTEXT_WINDOW)
  const historyMessages = history.slice(-CONTEXT_WINDOW).map((msg) => ({
    role: msg.role === "ai" ? "assistant" : "user",
    content: msg.content,
  }));

  finalMessages.push(...historyMessages);

  // 4. Détermination de la consigne de langue stricte
  const targetLang = normalizeLanguage(detectedLanguage);
  let langInstruction = "";

  if (targetLang) {
    langInstruction = `\n\n[Instruction invisible pour l'IA : Réponds obligatoirement et entièrement en langue ${targetLang}]`;
  } else {
    langInstruction = `\n\n[Instruction invisible pour l'IA : Applique la règle "DETECTION AUTOMATIQUE DE LA LANGUE" définie dans ton style de communication]`;
  }

  // 5. Ajout du message utilisateur courant avec sa directive linguistique sécurisée
  finalMessages.push({
    role: "user",
    content: userMessage + langInstruction,
  });

  return finalMessages;
}
