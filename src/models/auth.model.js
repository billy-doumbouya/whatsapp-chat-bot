import mongoose from "mongoose";

// Stocke les credentials Baileys dans MongoDB
// Remplace le dossier /auth local qui disparaît à chaque redémarrage Railway

const authSchema = new mongoose.Schema(
  {
    _id: { type: String }, // "creds" ou "key-xxx"
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

export const Auth = mongoose.model("Auth", authSchema);
