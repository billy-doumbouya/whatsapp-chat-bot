import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ["user", "ai"],
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const conversationSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      unique: true,
      index: true,
      required: true,
    },
    // Human-readable contact name if available
    contactName: {
      type: String,
      default: null,
    },
    messages: [messageSchema],
    totalMessages: {
      type: Number,
      default: 0,
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Keep only last 50 messages to avoid unbounded growth
conversationSchema.pre("save", function (next) {
  if (this.messages.length > 50) {
    this.messages = this.messages.slice(-50);
  }
  next();
});

export const Conversation = mongoose.model("Conversation", conversationSchema);
