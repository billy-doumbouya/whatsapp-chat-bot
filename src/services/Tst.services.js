import Groq from "groq-sdk";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const groq = new Groq({ apiKey: env.groqApiKey });

// Voix française naturelle Groq PlayAI
// Autres options FR : "Adama-PlayAI", "Asel-PlayAI"
const TTS_VOICE = "Celeste-PlayAI";
const TTS_MODEL = "playai-tts";

/**
 * Convertit un texte en buffer audio MP3 via Groq TTS
 * Utilise la même clé Groq déjà dans le projet — aucun coût supplémentaire
 * @param {string} text
 * @returns {Promise<Buffer|null>}
 */
export async function textToSpeech(text) {
  try {
    // Tronquer si trop long (limite Groq TTS ~4096 chars)
    const input = text.slice(0, 4000);

    const response = await groq.audio.speech.create({
      model: TTS_MODEL,
      input,
      voice: TTS_VOICE,
      response_format: "mp3",
    });

    // Convertir la réponse en Buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logger.info({ size: buffer.length }, "[TTS] Audio generated");
    return buffer;
  } catch (err) {
    logger.error({ err: err.message }, "[TTS] Failed to generate audio");
    return null;
  }
}
