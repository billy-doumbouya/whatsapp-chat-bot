import { Auth } from "../models/auth.model.js";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { logger } from "../config/logger.js";

/**
 * Remplace useMultiFileAuthState par une version MongoDB.
 * La session survit aux redémarrages Railway.
 */
export async function useMongoAuthState() {
  // Charge les credentials depuis MongoDB
  async function readData(id) {
    const doc = await Auth.findById(id).lean();
    if (!doc) return null;
    return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
  }

  // Sauvegarde dans MongoDB
  async function writeData(id, data) {
    const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await Auth.findByIdAndUpdate(
      id,
      { data: serialized },
      { upsert: true, new: true },
    );
  }

  // Supprime une clé
  async function removeData(id) {
    await Auth.findByIdAndDelete(id);
  }

  // Init creds si première fois
  let creds = await readData("creds");
  if (!creds) {
    creds = initAuthCreds();
    await writeData("creds", creds);
    logger.info("[MongoAuth] New credentials initialized");
  } else {
    logger.info("[MongoAuth] Credentials loaded from MongoDB");
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const value = await readData(`key-${type}-${id}`);
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids || {})) {
              if (value) {
                await writeData(`key-${type}-${id}`, value);
              } else {
                await removeData(`key-${type}-${id}`);
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await writeData("creds", creds);
      logger.debug("[MongoAuth] Credentials saved");
    },
  };
}
