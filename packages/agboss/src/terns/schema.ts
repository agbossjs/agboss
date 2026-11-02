import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MIGRATIONS } from "./migrations.js";
import { TERN_STATUSES, type Tern, type VersionScore } from "./types.js";

const TernRow = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  thread_id: z.string(),
  tenant_id: z.string(),
  bundle: z.string(),
  created_at: z.string(),
  task: z.string(),
  replyWith: z.string(),
  status: z.enum(TERN_STATUSES),
  stop_reason: z.string(),
  route: z.string(),
  steps: z.string(),
  cost_usd: z.number(),
  prompt_version: z.string(),
  model_version: z.string(),
  replay_of: z.string().nullable(),
  config_version: z.string().nullable(),
  config_hash: z.string().nullable(),
});

const Route = z.array(z.string());
const Steps = z.array(z.object({ agent: z.string(), content: z.string() }));

const SummaryRow = z.object({
  prompt_version: z.string(),
  terns: z.number(),
  scored: z.number(),
  mean_score: z.number().nullable(),
  cost_usd: z.number(),
});

/**
 * Free text — a task, an answer, a summary — as its column keeps it (#521): JSON text, where a NUL
 * character is the escape `\u0000`, since node:sqlite reads a TEXT value only up to a NUL.
 */
export const storedTextOf = (text: string): string => JSON.stringify(text);

/** The free text a column keeps (`storedTextOf`). */
export const textOf = (stored: string): string => z.string().parse(JSON.parse(stored));

/** A database row → a typed Tern; rows are validated, never trusted. */
export function toTern(row: unknown): Tern {
  const r = TernRow.parse(row);
  return {
    id: r.id,
    runId: r.run_id,
    threadId: r.thread_id,
    tenantId: r.tenant_id,
    bundle: r.bundle,
    createdAt: r.created_at,
    task: textOf(r.task),
    replyWith: textOf(r.replyWith),
    status: r.status,
    stopReason: textOf(r.stop_reason),
    route: Route.parse(JSON.parse(r.route)),
    steps: Steps.parse(JSON.parse(r.steps)),
    costUsd: r.cost_usd,
    promptVersion: r.prompt_version,
    modelVersion: r.model_version,
    replayOf: r.replay_of,
    configVersion: r.config_version,
    configHash: r.config_hash,
  };
}

export function toVersionScore(row: unknown): VersionScore {
  const r = SummaryRow.parse(row);
  return {
    promptVersion: r.prompt_version,
    terns: r.terns,
    scored: r.scored,
    meanScore: r.mean_score,
    costUsd: r.cost_usd,
  };
}

/** Whether the connection checks foreign keys (`PRAGMA foreign_keys`). */
const checksForeignKeys = (db: DatabaseSync): boolean =>
  z.object({ foreign_keys: z.number() }).parse(db.prepare("PRAGMA foreign_keys").get())
    .foreign_keys === 1;

/**
 * The migrations not yet applied, in one `BEGIN IMMEDIATE` transaction (two connections may open
 * one file). Foreign keys are off while a migration rebuilds tables (SQLite's own procedure; the
 * pragma does nothing inside a transaction) and checked before they are on again.
 */
function migrate(db: DatabaseSync): void {
  const restore = checksForeignKeys(db);
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    migrateInTransaction(db);
    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length > 0)
      throw new Error(`migration left ${String(broken.length)} broken references`);
  } finally {
    if (restore) db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateInTransaction(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const { user_version: applied } = z
      .object({ user_version: z.number() })
      .parse(db.prepare("PRAGMA user_version").get());
    MIGRATIONS.slice(applied).forEach((sql, offset) => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${String(applied + offset + 1)}`);
    });
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** Migrates the Tern tables of an open database (a connection shared with other stores, #265). */
export const migrateTernDatabase = (db: DatabaseSync): void => {
  migrate(db);
};

/**
 * Opens (creating directories) and migrates the database. `node:sqlite` is loaded here, on first
 * use, so importing `agboss` never loads it (#195).
 */
export function openTernDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(",");
