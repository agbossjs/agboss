import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { toTurn } from "./schema.js";
import type { ConfigSnapshot, ConfigStore } from "./types.js";

const SnapshotRow = z.object({
  version: z.string(),
  hash: z.string(),
  snapshot: z.string(),
  first_seen: z.string(),
});

/** Config versions (table `config_versions`, migration 4) and recent original Terns. */
export function configMethods(db: DatabaseSync, now: () => Date): ConfigStore {
  return {
    rememberConfig: (bundle, version, hash, snapshot) => {
      // Hashes of another length were made by an older hashing scheme: not comparable, not drift.
      const others = db
        .prepare(
          `SELECT 1 FROM config_versions WHERE bundle = ? AND version = ? AND hash <> ?
           AND length(hash) = length(?)`,
        )
        .get(bundle, version, hash, hash);
      db.prepare("INSERT OR IGNORE INTO config_versions VALUES (?, ?, ?, ?, ?)").run(
        bundle,
        version,
        hash,
        snapshot,
        now().toISOString(),
      );
      return Promise.resolve({ drift: others !== undefined });
    },
    configSnapshots: (bundle, version) =>
      Promise.resolve(
        db
          .prepare(
            "SELECT * FROM config_versions WHERE bundle = ? AND version = ? ORDER BY first_seen",
          )
          .all(bundle, version)
          .map((row): ConfigSnapshot => {
            const r = SnapshotRow.parse(row);
            return {
              version: r.version,
              hash: r.hash,
              snapshot: r.snapshot,
              firstSeen: r.first_seen,
            };
          }),
      ),
    recentOriginals: (bundle, limit) =>
      Promise.resolve(
        db
          .prepare(
            `SELECT * FROM (SELECT rowid AS seq, * FROM terns WHERE bundle = ? AND replay_of IS NULL
             AND status = 'answered' ORDER BY rowid DESC LIMIT ?) ORDER BY seq`,
          )
          .all(bundle, limit)
          .map(toTurn),
      ),
  };
}
