import { logger } from "../config/logger.js";

// Wraps async route handlers — no try/catch needed in controllers
export const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Custom error class for operational errors
export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
  }
}

// Global error handler — must be registered last in Express
export function errorHandler(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational || false;

  if (!isOperational) {
    logger.error({ err, url: req.originalUrl, method: req.method }, "[Server] Unhandled error");
  } else {
    logger.warn({ message: err.message, url: req.originalUrl }, "[App] Operational error");
  }

  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}
