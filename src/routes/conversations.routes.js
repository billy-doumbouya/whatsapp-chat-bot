import { Router } from "express";
import { catchAsync } from "../middleware/errorHandler.js";
import { listConversations, deleteConversation } from "../controllers/conversations.controller.js";

const router = Router();

router.get("/", catchAsync(listConversations));
router.delete("/:phone", catchAsync(deleteConversation));

export default router;
