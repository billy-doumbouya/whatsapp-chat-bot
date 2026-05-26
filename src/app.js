import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, AppError } from "./middleware/errorHandler.js";
import routes from "./routes/index.js";
import { env } from "./config/env.js";

const app = express();

// ─── 1. Trust proxy ───────────────────────────────────────────────────────────
// FIX Bug 7: derrière nginx / Traefik / tout reverse proxy, Express
// lit l'IP dans X-Forwarded-For uniquement si trust proxy est activé.
// Sans ça, req.ip est toujours 127.0.0.1, ce qui casse le rate limiting par IP.
app.set("trust proxy", 1);

// ─── 2. Sécurité HTTP (headers) ──────────────────────────────────────────────
// FIX Bug 5: helmet() doit être le premier middleware pour s'appliquer
// à toutes les routes, y compris /health.
app.use(helmet());

// ─── 3. CORS ─────────────────────────────────────────────────────────────────
// FIX Bug 4: origin: "*" remplacé par une liste d'origines autorisées
// lue depuis l'env. En production, positionne APP_ALLOWED_ORIGINS
// à "https://ton-dashboard.com". En développement, "*" reste possible
// via env mais doit être une décision explicite.
const allowedOrigins = env.allowedOrigins
  ? env.allowedOrigins.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      // Autorise les appels sans Origin (Postman, curl, mobile clients)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false, // Passe à true si tu ajoutes des cookies de session
  }),
);

// ─── 4. Rate limiting ─────────────────────────────────────────────────────────
// FIX Bug 6: sans rate limit, le dashboard et les webhooks sont
// exposés au brute force et aux attaques par déni de service.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 requêtes par IP par fenêtre
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes. Réessaie dans 15 minutes." },
});

// ─── 5. Health check (avant les body parsers, après les headers sécurité) ───
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// ─── 6. Body parsers ─────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

// ─── 7. Logs des requêtes HTTP ───────────────────────────────────────────────
app.use(requestLogger);

// ─── 8. Routes API (avec rate limiter) ───────────────────────────────────────
app.use("/api", apiLimiter, routes);

// ─── 9. 404 handler ──────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  next(new AppError(`Route non trouvée : ${req.originalUrl}`, 404));
});

// ─── 10. Error handler global (doit rester le dernier middleware) ─────────────
app.use(errorHandler);

export default app;
