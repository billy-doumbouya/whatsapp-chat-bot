import Groq from "groq-sdk";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const groq = new Groq({ apiKey: env.groqApiKey });

/**
 * Transcrit un buffer audio en texte via Groq Whisper
 * @param {Buffer} audioBuffer
 * @param {string} mimeType - ex: "audio/ogg"
 * @returns {Promise<string|null>}
 */
export async function transcribeAudio(audioBuffer, mimeType = "audio/ogg") {
  try {
    // Groq attend un File-like object
    console.log("=== TRANSCRIPTION START ===");
    console.log("MIME:", mimeType);
    console.log("BUFFER SIZE:", audioBuffer?.length);

    const file = new File([audioBuffer], "audio.ogg", { type: mimeType });
    console.log("FILE created:", file.size);

    const transcription = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo", // gratuit, ultra rapide
      language: "fr",
      response_format: "text",
    });

    logger.info("[Transcription] Audio transcribed successfully");
    return typeof transcription === "string"
      ? transcription.trim()
      : transcription?.text?.trim() || null;
  } catch (err) {
    logger.error({ err: err.message }, "[Transcription] Failed");
    return null;
  }
}
