import express from "express";
import helmet from "helmet";
import cors from "cors";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, AppError } from "./middleware/errorHandler.js";
import routes from "./routes/index.js";

const app = express();

// Security headers
app.use(helmet());

// CORS — restrict to localhost in prod if you expose the API
app.use(cors({ origin: "*" }));

// Body parsing
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: false }));

// HTTP request logging
app.use(requestLogger);

// API routes
app.use("/api", routes);

// 404 handler
app.use((req, _res, next) => {
  next(new AppError(`Route not found: ${req.originalUrl}`, 404));
});

// Global error handler — must be last
app.use(errorHandler);

export default app;
