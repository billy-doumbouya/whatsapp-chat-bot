import "dotenv/config";
import { Bio } from "../data/bio.js";

const required = ["MONGO_URI", "OPENROUTER_API_KEY"];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[ENV] Missing required env variable: ${key}`);
    process.exit(1);
  }
}

export const env = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  app_url:
    process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
  app_name: process.env.APP_NAME || "WhatsApp Bot",
  isDev: process.env.NODE_ENV !== "production",

  mongoUri: process.env.MONGO_URI,

  gemini: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.AI_MODEL || "google/gemini-2.5-flash-preview:free",
  },

  bot: {
    name: process.env.BOT_NAME || "Billy Doumbouya",
    // Persona chargé depuis src/data/persona.js — plus maintenable qu'une variable .env
    persona: Bio,
    replyGroups: process.env.REPLY_GROUPS === "true",
    typingDelayMs: parseInt(process.env.TYPING_DELAY_MS || "1500", 10),
    // Numéro WhatsApp de Billy au format JID (ex: 224623952011@s.whatsapp.net)
    ownerJid: process.env.OWNER_JID || null,
  },
};
