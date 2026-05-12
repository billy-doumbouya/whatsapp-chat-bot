import { logger } from "../config/logger.js";

export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    logger.info({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start,
    }, "[HTTP]");
  });

  next();
}
