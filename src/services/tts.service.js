import Groq from "groq-sdk";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { Readable } from "stream";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// FIX Bug 8: cohérence — env.groqApiKey partout
const groq = new Groq({ apiKey: env.groqApiKey });

const VOICE_CONFIG = {
  fr: "Celeste-PlayAI",
  french: "Celeste-PlayAI",
  en: "Atlas-PlayAI",
  english: "Atlas-PlayAI",
  default: "Celeste-PlayAI",
};

const TTS_MODEL = "playai-tts";

/**
 * Supprime le Markdown et les caractères spéciaux avant synthèse vocale.
 * @param {string} text
 * @returns {string}
 */
function cleanTextForTTS(text) {
  if (!text) return "";
  return text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/[-•♦]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Découpe un texte long en segments de maxLength pour l'API TTS.
 * FIX Bug 9: la regex [.!?]+ rate les phrases sans ponctuation.
 * On découpe d'abord par ponctuation, puis par longueur brute si nécessaire.
 *
 * @param {string} text
 * @param {number} maxLength
 * @returns {string[]}
 */
function splitText(text, maxLength = 3000) {
  if (!text) return [];

  const cleaned = cleanTextForTTS(text);
  if (cleaned.length <= maxLength) return [cleaned];

  // Découpe par phrases (ponctuation) ou à défaut par mots
  const sentences = cleaned.match(/[^.!?]+[.!?]*/g) || [cleaned];
  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    // Si une phrase seule dépasse maxLength, on la coupe par mots
    if (sentence.length > maxLength) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      const words = sentence.split(" ");
      for (const word of words) {
        if ((current + " " + word).trim().length > maxLength) {
          if (current.trim()) chunks.push(current.trim());
          current = word;
        } else {
          current = current ? current + " " + word : word;
        }
      }
      continue;
    }

    if ((current + " " + sentence).trim().length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? current + " " + sentence : sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/**
 * Convertit un Buffer MP3 en OGG Opus compatible WhatsApp.
 *
 * FIX Bug 11 + Bug 12: le PassThrough pouvait émettre "end" avant que
 * FFmpeg ait flushed tous les chunks, et reject/resolve pouvaient être
 * appelés plusieurs fois en cas d'erreur.
 * Solution: on utilise un flag `settled` + on écoute "finish" sur
 * le PassThrough plutôt que "end".
 *
 * @param {Buffer} mp3Buffer
 * @returns {Promise<Buffer>}
 */
async function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const input = new Readable({
      read() {
        this.push(mp3Buffer);
        this.push(null);
      },
    });

    const proc = ffmpeg(input)
      .inputFormat("mp3")
      .audioCodec("libopus")
      .audioBitrate("32k")
      .audioChannels(1)
      .audioFrequency(48000)
      .format("ogg")
      .on("start", (cmd) => logger.debug({ cmd }, "[TTS] FFmpeg started"))
      .on("error", (err) => {
        logger.error({ err: err.message }, "[TTS] FFmpeg error");
        settle(reject, err);
      });

    const outputStream = proc.pipe();

    outputStream.on("data", (chunk) => chunks.push(chunk));

    // FIX Bug 11: "finish" garantit que le stream interne a bien
    // terminé d'écrire, contrairement à "end" sur un PassThrough.
    outputStream.on("finish", () => {
      settle(resolve, Buffer.concat(chunks));
    });

    outputStream.on("error", (err) => {
      logger.error({ err: err.message }, "[TTS] Output stream error");
      settle(reject, err);
    });
  });
}

/**
 * Génère une note vocale WhatsApp-ready à partir d'un texte.
 *
 * Pipeline: Texte → Nettoyage → Groq PlayAI TTS (MP3) → FFmpeg → OGG Opus
 *
 * FIX Bug 10: Buffer.concat(mp3Chunks) collait les headers MP3 de chaque
 * chunk, ce qui pouvait créer des artefacts. Pour les chunks multiples,
 * on convertit chaque chunk séparément en OGG puis on les concatène —
 * les streams OGG Opus se concatenent proprement contrairement au MP3.
 *
 * @param {string} text
 * @param {string} language
 * @returns {Promise<Buffer|null>}
 */
export async function textToSpeech(text, language = "fr") {
  try {
    if (!text?.trim()) {
      logger.warn("[TTS] Empty text received");
      return null;
    }

    const normalizedLang = String(language).toLowerCase().trim();
    const voice = VOICE_CONFIG[normalizedLang] ?? VOICE_CONFIG.default;
    const chunks = splitText(text);

    logger.info(
      { chunks: chunks.length, language: normalizedLang, voice },
      "[TTS] Starting synthesis",
    );

    const oggChunks = [];

    for (const chunk of chunks) {
      // Génération MP3 depuis Groq TTS
      const response = await groq.audio.speech.create({
        model: TTS_MODEL,
        voice,
        input: chunk,
        response_format: "mp3",
      });

      const arrayBuffer = await response.arrayBuffer();
      const mp3Buffer = Buffer.from(arrayBuffer);

      if (!mp3Buffer?.length) {
        throw new Error("Groq returned empty audio buffer");
      }

      // FIX Bug 10: conversion individuelle MP3→OGG par chunk
      // pour éviter les artefacts de header MP3 concatenés
      const oggChunk = await mp3ToOggOpus(mp3Buffer);
      oggChunks.push(oggChunk);
    }

    // Les streams OGG Opus se concatenent proprement
    const finalBuffer = Buffer.concat(oggChunks);

    logger.info({ size: finalBuffer.length }, "[TTS] OGG Opus ready");

    return finalBuffer;
  } catch (err) {
    logger.error(
      { err: err.message, stack: err.stack },
      "[TTS] Pipeline failed",
    );
    return null;
  }
}
