import Groq from "groq-sdk";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const groq = new Groq({ apiKey: env.groqApiKey });

// Liste des hallucinations fréquentes générées par Whisper sur des blancs ou bruits de fond
const WHISPER_HALLUCINATIONS = [
  /thank you for watching/i,
  /sous-titres/i,
  /traduction de/i,
  /rejoignez-nous/i,
  /merci d'avoir regardé/i,
];

/**
 * Filtre les phrases générées par erreur par Whisper sur les bruits de fond
 */
function isWhisperHallucination(text) {
  if (!text) return true;
  // Si le texte fait moins de 2 caractères ou correspond à un pattern d'hallucination connu
  if (text.length < 2) return true;
  return WHISPER_HALLUCINATIONS.some((pattern) => pattern.test(text));
}

/**
 * Maps standard mime-types to their respective file extensions for Groq payload safety
 * @param {string} mimeType
 * @returns {string} filename extension
 */
function getExtensionFromMime(mimeType) {
  if (mimeType.includes("ogg") || mimeType.includes("opus")) return "audio.ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
  if (mimeType.includes("wav")) return "audio.wav";
  return "audio.ogg";
}

/**
 * Transcribes an audio buffer and returns both text and the auto-detected language
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @returns {Promise<{ text: string, language: string } | null>}
 */
export async function transcribeAudio(audioBuffer, mimeType = "audio/ogg") {
  try {
    if (!audioBuffer || audioBuffer.length === 0) {
      logger.warn("[Transcription] Aborted: Empty or missing audio buffer");
      return null;
    }

    console.log("=== TRANSCRIPTION START ===");
    console.log("MIME:", mimeType);
    console.log("BUFFER SIZE (bytes):", audioBuffer.length);

    const filename = getExtensionFromMime(mimeType);

    // Safely transform buffer into a multipart payload compatible with Node.js environments
    const filePayload = await Groq.toFile(audioBuffer, filename, {
      type: mimeType,
    });

    // Request verbose_json format to extract language metrics from the model stream
    const transcription = await groq.audio.transcriptions.create({
      file: filePayload,
      model: "whisper-large-v3-turbo",
      response_format: "verbose_json",
    });

    const text = transcription.text?.trim() || null;
    const language = transcription.language || "french";

    // Sécurité Anti-Hallucination : Si Whisper a inventé du texte sur du bruit, on coupe court
    if (!text || isWhisperHallucination(text)) {
      logger.warn(
        { rawText: text },
        "[Transcription] Texte ignoré car identifié comme hallucination ou trop court.",
      );
      return null;
    }

    logger.info(
      { language, textLength: text.length },
      "[Transcription] Audio transcribed successfully",
    );
    return { text, language };
  } catch (err) {
    logger.error(
      {
        message: err.message,
        status: err?.status,
        code: err?.code,
      },
      "[Transcription] Failed",
    );
    return null;
  }
}
