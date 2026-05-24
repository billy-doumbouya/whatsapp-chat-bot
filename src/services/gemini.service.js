import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const OPEN_ROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES = 2;

// Fallback structuré sécurisé si l'API OpenRouter est totalement hors-ligne
const FALLBACK_JSON_REPLY = {
  should_reply: true,
  requires_human_intervention: false,
  reply_content: "Je regarde ça dès que je me pose 🙏",
};

/**
 * Envoie un payload de messages prêt à l'emploi à Gemini via OpenRouter et garantit un retour JSON.
 * @param {Array<{role: string, content: string}>} messagesPayload - Tableau de messages généré par le Prompt Builder
 * @param {number} attempt - Index de la tentative actuelle (gestion du backoff)
 * @returns {Promise<{ should_reply: boolean, requires_human_intervention: boolean, reply_content: string }>}
 */
export async function askGemini(messagesPayload, attempt = 0) {
  try {
    if (
      !messagesPayload ||
      !Array.isArray(messagesPayload) ||
      messagesPayload.length === 0
    ) {
      throw new Error(
        "Le payload de messages fourni au service Gemini est vide ou invalide",
      );
    }

    // Copie locale pour ne pas muter le payload d'origine par référence
    const finalMessages = [...messagesPayload];

    // On extrait le premier message (le bloc système complet) pour y greffer la contrainte stricte du JSON
    if (finalMessages[0] && finalMessages[0].role === "system") {
      finalMessages[0].content += `\n\n---
# TECHNICAL OUTPUT FORMAT constraint
Tu dois impérativement répondre sous la forme d'un objet JSON valide. Ne saute pas de ligne avant le JSON, n'ajoute pas de balises markdown \`\`\`json. Ton JSON doit respecter scrupuleusement cette structure :
{
  "should_reply": true ou false (met false si le message reçu n'appelle aucune action, réponse ou est une simple confirmation de fin de discussion),
  "requires_human_intervention": true ou false (met true si le sujet requiert une action manuelle de ta part ou si c'est trop sensible/confidentiel),
  "reply_content": "Le texte de ta réponse ici en te basant sur ton identité de Billy (laisse vide "" si should_reply est false ou requires_human_intervention est true)"
}`;
    }

    const response = await axios.post(
      OPEN_ROUTER_URL,
      {
        model: env.gemini.model,
        messages: finalMessages,
        // Une température basse supprime les caprices de formatage et les hallucinations sur le JSON
        temperature: 0.3,
        max_tokens: 500,
        // FORCE OPENROUTER / GEMINI A RENVOYER DU JSON
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${env.gemini.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com",
          "X-Title": "WhatsApp AI Core Engine",
        },
        timeout: 30000, // 30 secondes maximum avant timeout
      },
    );

    const rawContent = response.data?.choices?.[0]?.message?.content;
    if (!rawContent) {
      throw new Error("Structure de réponse vide reçue du endpoint OpenRouter");
    }

    // Extraction et Parsing sécurisé du JSON renvoyé par Gemini
    try {
      const parsedJson = JSON.parse(rawContent.trim());

      return {
        should_reply: parsedJson.should_reply ?? true,
        requires_human_intervention:
          parsedJson.requires_human_intervention ?? false,
        reply_content: parsedJson.reply_content || "",
      };
    } catch (parseError) {
      logger.error(
        { parseError: parseError.message, rawContent },
        "[OpenRouter] Échec du parsing JSON du contenu généré",
      );
      // Si l'IA a généré un JSON invalide, on passe la main à l'humain par sécurité pour éviter d'envoyer du texte brut corrompu
      return {
        should_reply: false,
        requires_human_intervention: true,
        reply_content: "",
      };
    }
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;

    logger.error(
      { status, detail, attempt },
      "[OpenRouter] La requête a échoué",
    );

    const isClientError =
      status && status >= 400 && status < 500 && status !== 429;

    if (isClientError) {
      logger.error(
        "[OpenRouter] Erreur fatale de configuration ou de payload (4xx). Annulation des tentatives.",
      );
      return FALLBACK_JSON_REPLY;
    }

    // Gestion du Backoff linéaire pour les codes 429 ou 5xx (erreurs serveurs temporaires)
    if (attempt < MAX_RETRIES) {
      const backoffTime = 1500 * (attempt + 1);
      logger.info(
        `[OpenRouter] Nouvelle tentative dans ${backoffTime}ms (Attempt ${attempt + 1}/${MAX_RETRIES})...`,
      );

      await new Promise((r) => setTimeout(r, backoffTime));
      return askGemini(messagesPayload, attempt + 1);
    }

    return FALLBACK_JSON_REPLY;
  }
}
