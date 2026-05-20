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
 * You can change voices later if needed
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
 * Split long text safely for TTS APIs
 * Avoids truncation and preserves sentence flow
 */
function splitText(text, maxLength = 3500) {
  if (!text) return [];

  const cleaned = text.replace(/\s+/g, " ").trim();

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
 * Convert MP3 buffer → WhatsApp-native OGG Opus
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
 * Text
 * → Groq PlayAI TTS (MP3)
 * → FFmpeg conversion (OGG Opus)
 * → Ready for WhatsApp PTT
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
     * Merge all MP3 chunks
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
