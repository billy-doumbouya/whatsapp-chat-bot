import { logger } from "../config/logger.js";

// Map langue Whisper → config VoiceRSS
const VOICE_CONFIG = {
  french: { hl: "fr-fr", v: "Hortense" },
  fr: { hl: "fr-fr", v: "Hortense" },
  english: { hl: "en-us", v: "Linda" },
  en: { hl: "en-us", v: "Linda" },
  mandinka: { hl: "fr-fr", v: "Hortense" }, // Fallback to French for Mandinka/Malinke
  default: { hl: "fr-fr", v: "Hortense" },
};

/**
 * Convertit un texte en buffer audio MP3 via VoiceRSS
 * Supporte français et anglais selon la langue détectée par Whisper
 * Clé gratuite : https://www.voicerss.org/registration.aspx (350 req/jour)
 * @param {string} text
 * @param {string} language - langue Whisper ex: "french", "english"
 * @returns {Promise<Buffer|null>}
 */
export async function textToSpeech(text, language = "french") {
  try {
    const apiKey = process.env.VOICERSS_API_KEY;
    if (!apiKey) {
      logger.warn("[TTS] VOICERSS_API_KEY not set — skipping voice reply");
      return null;
    }

    const config = VOICE_CONFIG[language] || VOICE_CONFIG.default;

    const params = new URLSearchParams({
      key: apiKey,
      hl: config.hl,
      v: config.v,
      src: text.slice(0, 500), // limite VoiceRSS
      r: "0", // vitesse normale
      c: "MP3",
      f: "16khz_16bit_mono",
    });

    const res = await fetch(`https://api.voicerss.org/?${params}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // VoiceRSS retourne "ERROR: ..." en texte si la clé est invalide
    const preview = buffer.slice(0, 6).toString();
    if (preview.startsWith("ERROR")) {
      logger.error({ err: buffer.toString() }, "[TTS] VoiceRSS API error");
      return null;
    }

    logger.info(
      { size: buffer.length, language, voice: config.v },
      "[TTS] Audio generated",
    );
    return buffer;
  } catch (err) {
    logger.error({ err: err.message }, "[TTS] Failed");
    return null;
  }
}
