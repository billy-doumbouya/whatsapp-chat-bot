import pino from "pino";
import { env } from "./env.js";

export const logger = pino(
  env.isDev
    ? {
        level: "debug",
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {
        level: "info",
      }
);
