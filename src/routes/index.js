import { Router } from "express";
import { catchAsync } from "../middleware/errorHandler.js";
import { getStatus } from "../controllers/status.controller.js";
import conversationsRoutes from "./conversations.routes.js";

const router = Router();

router.get("/health", catchAsync(getStatus));
router.use("/conversations", conversationsRoutes);

export default router;
