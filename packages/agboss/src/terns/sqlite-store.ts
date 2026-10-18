import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  migrateTernDatabase,
  openTernDatabase,
  placeholders,
  toTern,
  toVersionScore,
} from "./schema.js";
import { configMethods } from "./configs.js";
import { ternWrites } from "./writes.js";
import { memoryMethods } from "./summaries.js";
import { threadMethods, type NewThreadId } from "./threads.js";
import type { Tern, TernStore } from "./types.js";

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;
export type { NewThreadId } from "./threads.js";
type Rows = (sql: string, ...params: SQLInputValue[]) => Tern[];

function ternReads(rows: Rows): Pick<TernStore, "lastTerns" | "byIds" | "byVersion" | "unscored"> {
  return {
    lastTerns: (threadId, limit) =>
      Promise.resolve(
        rows(
          `SELECT * FROM (SELECT rowid AS seq, * FROM terns WHERE thread_id = ?
           ORDER BY rowid DESC LIMIT ?) ORDER BY seq`,
          threadId,
          limit,
        ),
      ),
    byIds: (ids) =>
      Promise.resolve(
        rows(
          `SELECT * FROM terns WHERE id IN (${placeholders(ids.length)}) ORDER BY rowid`,
          ...ids,
        ),
      ),
    byVersion: (bundle, version, limit) =>
      Promise.resolve(
        rows(
          `SELECT * FROM terns WHERE bundle = ? AND prompt_version = ? AND replay_of IS NULL
           AND status != 'running'
           ORDER BY rowid LIMIT ?`,
          bundle,
          version,
          limit,
        ),
      ),
    unscored: (bundle, version, limit) =>
      Promise.resolve(
        rows(
          `SELECT t.* FROM terns t WHERE t.bundle = ? AND (? IS NULL OR t.prompt_version = ?)
           AND t.status = 'answered' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.tern_id = t.id)
           ORDER BY t.rowid LIMIT ?`,
          bundle,
          version ?? null,
          version ?? null,
          limit,
        ),
      ),
  };
}

/** Recovery's look-up (#265 S30): a page of the Terns with one status, oldest first. */
function statusReads(rows: Rows): Pick<TernStore, "byStatus"> {
  return {
    byStatus: (status, limit, after) =>
      Promise.resolve(
        rows(
          `SELECT * FROM terns WHERE status = ?
           AND rowid > COALESCE((SELECT rowid FROM terns WHERE id = ?), 0) ORDER BY rowid LIMIT ?`,
          status,
          after ?? null,
          limit,
        ),
      ),
  };
}

const SUMMARY = `SELECT t.prompt_version, COUNT(DISTINCT t.id) AS terns, COUNT(s.score) AS scored,
    AVG(s.score) AS mean_score,
    (SELECT SUM(cost_usd) FROM terns x WHERE x.bundle = t.bundle AND x.prompt_version = t.prompt_version
      AND x.status != 'running') AS cost_usd
  FROM terns t LEFT JOIN scores s ON s.tern_id = t.id
  WHERE t.bundle = ? AND t.status != 'running' GROUP BY t.prompt_version ORDER BY MIN(t.rowid)`;

function scoreMethods(
  db: DatabaseSync,
  now: Now,
): Pick<TernStore, "saveScore" | "meanScore" | "summary"> {
  return {
    saveScore: (ternId, judge, score) => {
      db.prepare("INSERT INTO scores VALUES (?, ?, ?, ?)").run(
        ternId,
        judge,
        score,
        now().toISOString(),
      );
      return Promise.resolve();
    },
    meanScore: (ternIds) => {
      const sql = `SELECT AVG(score) AS mean FROM scores WHERE tern_id IN (${placeholders(ternIds.length)})`;
      const row = z.object({ mean: z.number().nullable() }).parse(db.prepare(sql).get(...ternIds));
      return Promise.resolve(row.mean);
    },
    summary: (bundle) => Promise.resolve(db.prepare(SUMMARY).all(bundle).map(toVersionScore)),
  };
}

/** Terns in SQLite (built-in `node:sqlite`) on a file of their own. `:memory:` for tests. */
export function createSqliteTernStore(
  path: string,
  now: Now,
  newThreadId: NewThreadId = randomUUID,
): TernStore {
  return ternStoreOn(openTernDatabase(path), now, newThreadId);
}

/**
 * Terns on an open database — a connection other stores share (#265): its tables migrated first.
 * `close` closes that connection.
 */
export function sharedTernStore(
  db: DatabaseSync,
  now: Now,
  newThreadId: NewThreadId = randomUUID,
): TernStore {
  migrateTernDatabase(db);
  return ternStoreOn(db, now, newThreadId);
}

function ternStoreOn(db: DatabaseSync, now: Now, newThreadId: NewThreadId): TernStore {
  const rows: Rows = (sql, ...params) =>
    db
      .prepare(sql)
      .all(...params)
      .map(toTern);
  return {
    ...threadMethods(db, now, newThreadId),
    ...ternWrites(db, now),
    ...ternReads(rows),
    ...statusReads(rows),
    ...scoreMethods(db, now),
    ...memoryMethods(db, now),
    ...configMethods(db, now),
    close: () => {
      db.close();
    },
  };
}
