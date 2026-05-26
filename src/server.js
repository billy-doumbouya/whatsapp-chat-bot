import "dotenv/config";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDB } from "./config/db.js";
import app from "./app.js";
import { startWhatsApp } from "./services/whatsapp.client.js";
import { handleIncomingMessage, onHumanReply } from "./services/bot.service.js";

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let server = null;

/**
 * Arrêt propre : ferme le serveur HTTP, puis quitte.
 * FIX Bug 1: SIGTERM ajouté — Docker, systemd et Kubernetes envoient
 * SIGTERM pour arrêter le process. Sans ce handler, le process était
 * tué brutalement (SIGKILL après timeout) sans aucun cleanup.
 */
function shutdown(signal) {
  logger.info({ signal }, "[Boot] Graceful shutdown initiated");

  if (server) {
    server.close(() => {
      logger.info("[Boot] HTTP server closed");
      process.exit(0);
    });

    // Forçage après 10s si le serveur ne se ferme pas proprement
    setTimeout(() => {
      logger.error("[Boot] Forced exit after timeout");
      process.exit(1);
    }, 10_000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ─── Sécurités globales ───────────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  logger.error(
    { reason: String(reason) },
    "[Boot] Unhandled Promise Rejection",
  );
  // On ne quitte pas — on laisse le process continuer pour les autres conversations
});

process.on("uncaughtException", (err) => {
  logger.error(
    { err: err.message, stack: err.stack },
    "[Boot] Uncaught Exception — process will exit",
  );
  process.exit(1);
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap() {
  logger.info("[Boot] Starting WhatsApp AI Bot...");

  // 1. Connexion MongoDB
  await connectDB();

  // 2. Démarrage du serveur HTTP Express
  // FIX Bug 3: event "error" ajouté pour capturer les erreurs réseau
  // (port déjà pris, permission refusée, etc.) qui n'apparaissent pas dans le callback listen().
  await new Promise((resolve, reject) => {
    server = app
      .listen(env.port, () => {
        logger.info({ port: env.port, url: env.app_url }, "[Boot] API ready");
        resolve();
      })
      .on("error", (err) => {
        logger.error(
          { err: err.message },
          "[Boot] HTTP server failed to start",
        );
        reject(err);
      });
  });

  // 3. Initialisation du client WhatsApp
  await startWhatsApp({
    onIncomingMessage: handleIncomingMessage,
    onHumanReply,
  });

  logger.info("[Boot] Bot execution loop successfully initialized ✓");
}

// FIX Bug 2: bootstrap() appelée avec .catch() explicite.
// Sans ça, une erreur pendant l'init (DB down, port occupé, etc.)
// tombait dans unhandledRejection au lieu de stopper proprement le process.
bootstrap().catch((err) => {
  logger.error(
    { err: err.message, stack: err.stack },
    "[Boot] Fatal startup error — exiting",
  );
  process.exit(1);
});
