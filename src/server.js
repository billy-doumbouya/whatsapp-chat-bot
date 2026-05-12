import "dotenv/config";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDB } from "./config/db.js";
import app from "./app.js";
import { startWhatsApp } from "./services/whatsapp.client.js";
import { handleIncomingMessage } from "./services/bot.service.js";

async function bootstrap() {
  logger.info("[Boot] Starting WhatsApp AI Bot...");

  // 1. Connect to MongoDB
  await connectDB();

  // 2. Start Express server
  app.listen(env.port, () => {
    logger.info(`[Boot] API listening on http://localhost:${env.port}`);
  });

  // 3. Start WhatsApp bot
  await startWhatsApp(handleIncomingMessage);

  logger.info("[Boot] Bot ready ✓");
}

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("[Boot] Shutting down...");
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "[Boot] Unhandled Promise Rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "[Boot] Uncaught Exception");
  process.exit(1);
});

bootstrap();
