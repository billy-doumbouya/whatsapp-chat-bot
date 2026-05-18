import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { Readable, PassThrough } from "stream"; // FIXED: Swapped custom Writable for reliable PassThrough
import { logger } from "../config/logger.js";

// Map fluent-ffmpeg to our node_modules embedded binary layout
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const VOICE_CONFIG = {
  french: { hl: "fr-fr", v: "Barent" }, // Standard native French Male
  fr: { hl: "fr-fr", v: "Barent" },
  english: { hl: "en-us", v: "John" }, // Standard native US English Male
  en: { hl: "en-us", v: "John" },
  mandinka: { hl: "fr-fr", v: "Barent" }, // Fallback to French Male profile
  default: { hl: "fr-fr", v: "Barent" },
};

/**
 * Converts an MP3 Buffer into WhatsApp-native compliant OGG Opus using fluid stream bindings
 * @param {Buffer} mp3Buffer
 * @returns {Promise<Buffer>}
 */
function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    // Initialize raw readable memory stream
    const input = new Readable();
    input.push(mp3Buffer);
    input.push(null);

    // FIXED: Using a PassThrough stream ensures the lifecycle data layers resolve seamlessly on 'end'
    const output = new PassThrough();

    output.on("data", (chunk) => chunks.push(chunk));

    // Core FFmpeg pipeline processing engine
    ffmpeg(input)
      .inputFormat("mp3")
      .audioCodec("libopus")
      .audioBitrate("24k")
      .audioFrequency(48000)
      .audioChannels(1)
      .format("ogg")
      .on("error", (err) => {
        logger.error(
          { err: err.message },
          "[TTS] ffmpeg processing operation failed",
        );
        reject(err);
      })
      .on("end", () => {
        // Safely consolidate individual stream chunks into a single audio buffer on close
        resolve(Buffer.concat(chunks));
      })
      .pipe(output);
  });
}

/**
 * Generates an OGG Opus audio buffer from input text strings for WhatsApp PTT
 * @param {string} text
 * @param {string} language - Input language coming from the Whisper module
 * @returns {Promise<Buffer|null>}
 */
export async function textToSpeech(text, language = "french") {
  try {
    const apiKey = process.env.VOICERSS_API_KEY;
    if (!apiKey) {
      logger.warn(
        "[TTS] VOICERSS_API_KEY not set — skipping voice reply generation",
      );
      return null;
    }

    if (!text || text.trim() === "") {
      logger.warn("[TTS] Aborted: Text payload input is empty");
      return null;
    }

    // FIXED: Restored normalization to prevent case-sensitive mismatches with Whisper strings
    const normalizedLang = String(language).toLowerCase().trim();
    const config = VOICE_CONFIG[normalizedLang] || VOICE_CONFIG.default;

    const params = new URLSearchParams({
      key: apiKey,
      hl: config.hl,
      v: config.v,
      src: text.slice(0, 500), // Enforce strict VoiceRSS character limits
      r: "0", // Playback speed rate configuration
      c: "MP3",
      f: "16khz_16bit_mono",
    });

    const res = await fetch(`https://api.voicerss.org/?${params}`);

    if (!res.ok) {
      throw new Error(
        `HTTP network error communication exception. Status: ${res.status}`,
      );
    }

    const mp3Buffer = Buffer.from(await res.arrayBuffer());

    // Validation Guard: Catch inline VoiceRSS explicit text error strings inside HTTP 200 states
    if (mp3Buffer.slice(0, 6).toString().startsWith("ERROR")) {
      logger.error(
        { err: mp3Buffer.toString() },
        "[TTS] VoiceRSS API upstream rejection token",
      );
      return null;
    }

    logger.info(
      { size: mp3Buffer.length, language: normalizedLang, voice: config.v },
      "[TTS] MP3 audio payload generated",
    );

    // Convert MP3 → OGG Opus for WhatsApp PTT compatibility
    const oggBuffer = await mp3ToOggOpus(mp3Buffer);
    logger.info(
      { size: oggBuffer.length },
      "[TTS] Converted to OGG Opus safely ✓",
    );

    return oggBuffer;
  } catch (err) {
    logger.error(
      { err: err.message, stack: err.stack },
      "[TTS] Execution pipeline crashed",
    );
    return null;
  }
}
