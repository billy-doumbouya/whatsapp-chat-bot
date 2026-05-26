import Groq from "groq-sdk";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

// FIX Bug 8: cohérence avec tts.service.js — on utilise env partout,
// plus de process.env.GROQ_API_KEY direct.
const groq = new Groq({ apiKey: env.groqApiKey });

// Seuil au-delà duquel Whisper considère qu'il n'y a pas de parole réelle.
// FIX Bug 7: verbose_json expose no_speech_prob mais il n'était jamais vérifié.
// Valeur recommandée par la doc Groq/OpenAI : > 0.6 = probablement pas de parole.
const NO_SPEECH_THRESHOLD = 0.6;

// Hallucinations fréquentes de Whisper sur les bruits de fond ou silences
const WHISPER_HALLUCINATIONS = [
  /thank you for watching/i,
  /sous-titres/i,
  /traduction de/i,
  /rejoignez-nous/i,
  /merci d'avoir regardé/i,
  /subtitled by/i,
  /amara\.org/i,
];

/**
 * Détecte les sorties hallucinées ou trop courtes de Whisper.
 * @param {string|null} text
 * @returns {boolean}
 */
function isWhisperHallucination(text) {
  if (!text || text.length < 2) return true;
  return WHISPER_HALLUCINATIONS.some((pattern) => pattern.test(text));
}

/**
 * Mappe un mime-type vers le nom de fichier attendu par l'API Groq.
 * @param {string} mimeType
 * @returns {string}
 */
function getFilenameFromMime(mimeType) {
  if (mimeType.includes("ogg") || mimeType.includes("opus")) return "audio.ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
  if (mimeType.includes("wav")) return "audio.wav";
  return "audio.ogg";
}

/**
 * Transcrit un buffer audio et retourne le texte + la langue détectée.
 *
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @returns {Promise<{ text: string, language: string } | null>}
 */
export async function transcribeAudio(audioBuffer, mimeType = "audio/ogg") {
  try {
    if (!audioBuffer || audioBuffer.length === 0) {
      logger.warn("[Transcription] Aborted: empty audio buffer");
      return null;
    }

    // FIX Bug 6: console.log() remplacés par logger.debug()
    logger.debug(
      { mimeType, bufferSize: audioBuffer.length },
      "[Transcription] Starting",
    );

    const filename = getFilenameFromMime(mimeType);

    const filePayload = await Groq.toFile(audioBuffer, filename, {
      type: mimeType,
    });

    const transcription = await groq.audio.transcriptions.create({
      file: filePayload,
      model: "whisper-large-v3-turbo",
      response_format: "verbose_json",
    });

    const text = transcription.text?.trim() || null;
    const language = transcription.language || "french";

    // FIX Bug 7: Vérification du no_speech_prob retourné par verbose_json.
    // Si Whisper est peu confiant sur la présence de parole, on rejette.
    const segments = transcription.segments || [];
    const avgNoSpeechProb =
      segments.length > 0
        ? segments.reduce((sum, s) => sum + (s.no_speech_prob ?? 0), 0) /
          segments.length
        : 0;

    if (avgNoSpeechProb > NO_SPEECH_THRESHOLD) {
      logger.warn(
        { avgNoSpeechProb, text },
        "[Transcription] Rejected: high no_speech_prob (probablement silence ou bruit)",
      );
      return null;
    }

    if (!text || isWhisperHallucination(text)) {
      logger.warn(
        { text },
        "[Transcription] Rejected: hallucination or too short",
      );
      return null;
    }

    logger.info(
      { language, length: text.length, avgNoSpeechProb },
      "[Transcription] Success",
    );

    return { text, language };
  } catch (err) {
    logger.error(
      { message: err.message, status: err?.status, code: err?.code },
      "[Transcription] Failed",
    );
    return null;
  }
}
