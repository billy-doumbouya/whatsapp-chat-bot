import { Auth } from "../models/auth.model.js";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { logger } from "../config/logger.js";

/**
 * Remplace useMultiFileAuthState par une version MongoDB.
 * La session survit aux redémarrages Railway.
 *
 * FIX performance : les clés Signal étaient lues et écrites une par une
 * en séquentiel (boucle for + await individuel). Sur Railway avec latence
 * réseau MongoDB, chaque message entrant déclenchait 10-30 requêtes DB.
 * Remplacé par des lectures/écritures en bulk (Promise.all + bulkWrite).
 */

// ─── Helpers sérialisation ────────────────────────────────────────────────────

function serialize(data) {
  return JSON.parse(JSON.stringify(data, BufferJSON.replacer));
}

function deserialize(data) {
  return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
}

// ─── Opérations DB ───────────────────────────────────────────────────────────

async function readData(id) {
  const doc = await Auth.findById(id).lean();
  if (!doc) return null;
  return deserialize(doc.data);
}

async function writeData(id, data) {
  await Auth.findByIdAndUpdate(
    id,
    { data: serialize(data) },
    { upsert: true, new: true },
  );
}

async function removeData(id) {
  await Auth.findByIdAndDelete(id);
}

// ─── Point d'entrée ───────────────────────────────────────────────────────────

export async function useMongoAuthState() {
  // Init creds si première connexion
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
        /**
         * Lecture en bulk : toutes les clés demandées en une seule
         * passe parallèle au lieu d'une boucle séquentielle.
         */
        get: async (type, ids) => {
          const results = await Promise.all(
            ids.map((id) =>
              readData(`key-${type}-${id}`)
                .then((value) => ({ id, value }))
                .catch(() => ({ id, value: null })),
            ),
          );

          const data = {};
          for (const { id, value } of results) {
            if (value != null) data[id] = value;
          }
          return data;
        },

        /**
         * Écriture en bulk : une seule opération bulkWrite MongoDB
         * au lieu d'une boucle de findByIdAndUpdate individuels.
         */
        set: async (data) => {
          const ops = [];

          for (const [type, ids] of Object.entries(data)) {
            for (const [id, value] of Object.entries(ids || {})) {
              const docId = `key-${type}-${id}`;

              if (value) {
                ops.push({
                  updateOne: {
                    filter: { _id: docId },
                    update: { $set: { data: serialize(value) } },
                    upsert: true,
                  },
                });
              } else {
                ops.push({
                  deleteOne: {
                    filter: { _id: docId },
                  },
                });
              }
            }
          }

          if (ops.length > 0) {
            await Auth.bulkWrite(ops, { ordered: false });
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
