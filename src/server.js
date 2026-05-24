import "dotenv/config";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDB } from "./config/db.js";
import app from "./app.js";
import { startWhatsApp } from "./services/whatsapp.client.js";
import { handleIncomingMessage, onHumanReply } from "./services/bot.service.js"; // Importation des deux capteurs

async function bootstrap() {
  logger.info("[Boot] Starting WhatsApp AI Bot...");

  // 1. Connexion à la base MongoDB
  await connectDB();

  // 2. Démarrage de l'API Express (Dashboard / Webhooks)
  app.listen(env.port, () => {
    logger.info(`[Boot] API listening on URL: ${env.app_url}`);
  });

  // 3. Initialisation du client WhatsApp avec les deux flux de capture
  // handleIncomingMessage : Écoute les autres
  // onHumanReply : T'écoute toi (Billy) pour couper l'IA si tu prends la main
  await startWhatsApp({
    onIncomingMessage: handleIncomingMessage,
    onHumanReply: onHumanReply,
  });

  logger.info("[Boot] Bot execution loop successfully initialized ✓");
}

// Graceful shutdown - Fermeture propre des connexions
process.on("SIGINT", () => {
  logger.info("[Boot] Shutting down application gracefully...");
  process.exit(0);
});

// Sécurités globales contre les crashs asynchrones de Node.js
process.on("unhandledRejection", (reason, promise) => {
  logger.error(
    { reason, promise },
    "[Boot] Critical Unhandled Promise Rejection detected",
  );
});

process.on("uncaughtException", (err) => {
  logger.error(
    { err: err.message, stack: err.stack },
    "[Boot] Critical Uncaught Exception thrown",
  );
  process.exit(1);
});

bootstrap();
