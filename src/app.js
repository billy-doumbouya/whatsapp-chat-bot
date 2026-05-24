import express from "express";
import helmet from "helmet";
import cors from "cors";
import { requestLogger } from "./middleware/requestLogger.js";
import { errorHandler, AppError } from "./middleware/errorHandler.js";
import routes from "./routes/index.js";

const app = express();

// 1. Couche de Sécurité Globale (Headers HTTP standardisés)
app.use(helmet());

// 2. Configuration CORS restrictive (À adapter selon ton environnement de déploiement)
app.use(cors({ origin: "*" }));

// 3. Endpoint de Diagnostic léger (Health Check) - Placé avant les logs de requêtes pour éviter de polluer tes fichiers log
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// 4. Analyseurs de requêtes (Body Parsers)
// Rehaussé à 2mb pour encaisser d'éventuels retours de webhooks d'automatisation ou de volumineuses payloads de logs
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

// 5. Journalisation des requêtes HTTP (Morgan ou logger customisé)
app.use(requestLogger);

// 6. Montage du routeur principal de l'API
app.use("/api", routes);

// 7. Intercepteur 404 pour capturer les routes inexistantes
app.use((req, _res, next) => {
  next(
    new AppError(`Route non trouvée sur ce serveur : ${req.originalUrl}`, 404),
  );
});

// 8. Gestionnaire d'erreurs global centralisé (Doit impérativement rester le dernier middleware connecté)
app.use(errorHandler);

export default app;
