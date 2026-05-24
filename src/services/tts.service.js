import Groq from "groq-sdk";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { Readable, PassThrough } from "stream";
import { logger } from "../config/logger.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

/**
 * Multilingual voice mapping
 */
const VOICE_CONFIG = {
  fr: "Celeste-PlayAI",
  french: "Celeste-PlayAI",
  en: "Atlas-PlayAI",
  english: "Atlas-PlayAI",
  default: "Celeste-PlayAI",
};

const TTS_MODEL = "playai-tts";

/**
 * Supprime le Markdown et les caractères spéciaux que l'IA écrit
 * mais que la synthèse vocale ne doit pas prononcer.
 */
function cleanTextForTTS(text) {
  if (!text) return "";
  return text
    .replace(/\*\*/g, "") // Supprime les gras **
    .replace(/\*/g, "") // Supprime les italiques *
    .replace(/`/g, "") // Supprime les backticks code
    .replace(/[-•♦]/g, ",") // Remplace les puces de listes par des virgules pour marquer une pause naturelle
    .replace(/\s+/g, " ") // Normalise les espaces
    .trim();
}

/**
 * Split long text safely for TTS APIs
 * Avoids truncation and preserves sentence flow
 */
function splitText(text, maxLength = 3000) {
  if (!text) return [];

  const cleaned = cleanTextForTTS(text);

  if (cleaned.length <= maxLength) {
    return [cleaned];
  }

  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${sentence} `;
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Convert multiple MP3 buffers joined into a single coherent WhatsApp-native OGG Opus
 */
async function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const input = new Readable({
      read() {
        this.push(mp3Buffer);
        this.push(null);
      },
    });

    const output = new PassThrough();

    output.on("data", (chunk) => {
      chunks.push(chunk);
    });

    output.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    ffmpeg(input)
      .inputFormat("mp3")
      // Utilisation du filtre d'encodage universellement accepté par l'application mobile WhatsApp
      .audioCodec("libopus")
      .audioBitrate("32k")
      .audioChannels(1)
      .audioFrequency(48000)
      .format("ogg")
      .on("start", (cmd) => {
        logger.debug({ cmd }, "[TTS] FFmpeg started");
      })
      .on("error", (err) => {
        logger.error({ err: err.message }, "[TTS] FFmpeg conversion failed");
        reject(err);
      })
      .on("end", () => {
        logger.debug("[TTS] FFmpeg conversion completed");
      })
      .pipe(output, { end: true });
  });
}

/**
 * Generate high-quality WhatsApp-ready voice note
 *
 * Pipeline:
 * Text -> Clean Markdown -> Groq PlayAI TTS (MP3 Chunks) -> Merged Buffers -> FFmpeg (OGG Opus)
 *
 * @param {string} text
 * @param {string} language
 * @returns {Promise<Buffer|null>}
 */
export async function textToSpeech(text, language = "fr") {
  try {
    if (!text || !text.trim()) {
      logger.warn("[TTS] Empty text received");
      return null;
    }

    const normalizedLang = String(language).toLowerCase().trim();
    const voice = VOICE_CONFIG[normalizedLang] || VOICE_CONFIG.default;

    // Découpe après nettoyage automatique du texte
    const chunks = splitText(text);

    logger.info(
      {
        chunks: chunks.length,
        language: normalizedLang,
        voice,
      },
      "[TTS] Starting synthesis",
    );

    const mp3Chunks = [];

    /**
     * Generate MP3 chunks from Groq TTS
     */
    for (const chunk of chunks) {
      const response = await groq.audio.speech.create({
        model: TTS_MODEL,
        voice,
        input: chunk,
        response_format: "mp3",
      });

      const arrayBuffer = await response.arrayBuffer();
      const mp3Buffer = Buffer.from(arrayBuffer);

      if (!mp3Buffer || mp3Buffer.length === 0) {
        throw new Error("Groq returned empty audio buffer");
      }

      mp3Chunks.push(mp3Buffer);
    }

    /**
     * Merge all MP3 chunks safely
     */
    const mergedMp3 = Buffer.concat(mp3Chunks);

    logger.info(
      {
        size: mergedMp3.length,
      },
      "[TTS] MP3 synthesis completed",
    );

    /**
     * Convert to WhatsApp-native OGG Opus
     */
    const oggOpusBuffer = await mp3ToOggOpus(mergedMp3);

    logger.info(
      {
        size: oggOpusBuffer.length,
      },
      "[TTS] OGG Opus conversion completed",
    );

    return oggOpusBuffer;
  } catch (err) {
    logger.error(
      {
        err: err.message,
        stack: err.stack,
      },
      "[TTS] Pipeline failed",
    );

    return null;
  }
}
