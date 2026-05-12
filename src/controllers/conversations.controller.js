import { getAllConversations, clearHistory } from "../services/memory.service.js";
import { AppError } from "../middleware/errorHandler.js";

export async function listConversations(req, res) {
  const conversations = await getAllConversations();
  res.json({ success: true, count: conversations.length, data: conversations });
}

export async function deleteConversation(req, res) {
  const { phone } = req.params;
  if (!phone) throw new AppError("Phone is required", 400);

  await clearHistory(decodeURIComponent(phone));
  res.json({ success: true, message: "History cleared" });
}
