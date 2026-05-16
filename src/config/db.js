import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "./logger.js";
import dns from "dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

export async function connectDB() {
  try {
    await mongoose.connect(env.mongoUri);
    logger.info("[DB] MongoDB connected");
  } catch (err) {
    logger.error({ err }, "[DB] Connection failed");
    process.exit(1);
  }

  mongoose.connection.on("disconnected", () => {
    logger.warn("[DB] MongoDB disconnected");
  });

  mongoose.connection.on("error", (err) => {
    logger.error({ err }, "[DB] MongoDB error");
  });
}
