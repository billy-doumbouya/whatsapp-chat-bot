import "dotenv/config";
import { Bio } from "../data/bio.js";

// ─── Validation des variables obligatoires ────────────────────────────────────
const REQUIRED_VARS = [
  "MONGO_URI",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OWNER_JID", // Critique — sans ça les escalades humaines ne fonctionnent pas
];

const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  // On liste toutes les variables manquantes d'un coup plutôt que de s'arrêter à la première
  console.error(`[ENV] Missing required env variables: ${missing.join(", ")}`);
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseInt10(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// ─── Config exportée ─────────────────────────────────────────────────────────
export const env = {
  port: parseInt10(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  app_url:
    process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
  app_name: process.env.APP_NAME || "WhatsApp Bot",
  isDev: process.env.NODE_ENV !== "production",
  isProd: process.env.NODE_ENV === "production",

  mongoUri: process.env.MONGO_URI,

  groqApiKey: process.env.GROQ_API_KEY,

  // Origines CORS autorisées — utilisé dans app.js
  // Ex: APP_ALLOWED_ORIGINS=https://dashboard.com,http://localhost:3000
  allowedOrigins: process.env.APP_ALLOWED_ORIGINS || "",

  gemini: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.AI_MODEL || "google/gemini-2.0-flash",
  },

  bot: {
    name: process.env.BOT_NAME || "Billy Doumbouya",
    persona: Bio,
    replyGroups: process.env.REPLY_GROUPS === "true",
    typingDelayMs: parseInt10(process.env.TYPING_DELAY_MS, 1500),
    ownerJid: process.env.OWNER_JID, // Requis — validé ci-dessus
    wifeJid: process.env.WIFE_JID || null,
    wifeName: process.env.WIFE_NAME || "Sara",
  },
};
