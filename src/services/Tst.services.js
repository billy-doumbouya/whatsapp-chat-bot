import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { Readable, Writable } from "stream";
import { logger } from "../config/logger.js";

// Pointer ffmpeg vers le binaire embarqué dans node_modules
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const VOICE_CONFIG = {
  french: { hl: "fr-fr", v: "Hortense" },
  english: { hl: "en-us", v: "Linda" },
  mandinka: { hl: "fr-fr", v: "Hortense" },
  default: { hl: "fr-fr", v: "Hortense" },
};

/**
 * Convertit un buffer MP3 en OGG Opus via fluent-ffmpeg
 * WhatsApp PTT exige OGG Opus — MP3 direct ne fonctionne pas
 * @param {Buffer} mp3Buffer
 * @returns {Promise<Buffer>}
 */
function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const input = new Readable();
    input.push(mp3Buffer);
    input.push(null);

    const output = new Writable({
      write(chunk, _, cb) {
        chunks.push(chunk);
        cb();
      },
      final(cb) {
        resolve(Buffer.concat(chunks));
        cb();
      },
    });

    ffmpeg(input)
      .inputFormat("mp3")
      .audioCodec("libopus")
      .audioBitrate("24k")
      .audioFrequency(48000)
      .audioChannels(1)
      .format("ogg")
      .on("error", (err) => {
        logger.error({ err: err.message }, "[TTS] ffmpeg conversion failed");
        reject(err);
      })
      .pipe(output);
  });
}

/**
 * Génère un audio OGG Opus depuis un texte via VoiceRSS
 * Compatible WhatsApp PTT (push-to-talk)
 * @param {string} text
 * @param {string} language - "french" | "english"
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
      src: text.slice(0, 500),
      r: "0",
      c: "MP3",
      f: "16khz_16bit_mono",
    });

    const res = await fetch(`https://api.voicerss.org/?${params}`);
    const mp3Buffer = Buffer.from(await res.arrayBuffer());

    // VoiceRSS retourne "ERROR: ..." en texte si la clé est invalide
    if (mp3Buffer.slice(0, 6).toString().startsWith("ERROR")) {
      logger.error({ err: mp3Buffer.toString() }, "[TTS] VoiceRSS API error");
      return null;
    }

    logger.info(
      { size: mp3Buffer.length, language, voice: config.v },
      "[TTS] MP3 generated",
    );

    // Convertir MP3 → OGG Opus pour WhatsApp PTT
    const oggBuffer = await mp3ToOggOpus(mp3Buffer);
    logger.info({ size: oggBuffer.length }, "[TTS] Converted to OGG Opus ✓");

    return oggBuffer;
  } catch (err) {
    logger.error({ err: err.message }, "[TTS] Failed");
    return null;
  }
}
