import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parsedStoredJson } from "../core/stored-json.js";
import { TURN_STATUSES, type Turn } from "./types.js";

/**
 * The Turn tables of the 0.1.1 baseline (#1321c): the sixteen migrations of 0.1.0 squashed into the
 * schema they ended in, every statement `IF NOT EXISTS` (idempotent, keyed by the file's shape).
 * `PRAGMA user_version` = how many are applied; a release that changes a table appends one. 0.1.0
 * has no users: a file it wrote is not migrated.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS threads (id TEXT NOT NULL, bundle TEXT NOT NULL, created_at TEXT NOT NULL,
     tenant_id TEXT NOT NULL DEFAULT 'default', PRIMARY KEY (tenant_id, id));
   CREATE TABLE IF NOT EXISTS thread_owners (tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL,
     owner TEXT NOT NULL, PRIMARY KEY (tenant_id, thread_id),
     FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id));
   CREATE TABLE IF NOT EXISTS terns (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bundle TEXT NOT NULL,
     created_at TEXT NOT NULL, task TEXT NOT NULL, replyWith TEXT NOT NULL, status TEXT NOT NULL,
     stop_reason TEXT NOT NULL, route TEXT NOT NULL, steps TEXT NOT NULL, cost_usd REAL NOT NULL,
     prompt_version TEXT NOT NULL, model_version TEXT NOT NULL, replay_of TEXT,
     config_version TEXT, config_hash TEXT, run_id TEXT, tenant_id TEXT NOT NULL DEFAULT 'default',
     FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id));
   CREATE INDEX IF NOT EXISTS terns_thread ON terns(tenant_id, thread_id);
   CREATE INDEX IF NOT EXISTS terns_version ON terns(bundle, prompt_version);
   CREATE INDEX IF NOT EXISTS terns_status ON terns(status);
   CREATE INDEX IF NOT EXISTS terns_run ON terns(tenant_id, run_id);
   CREATE TABLE IF NOT EXISTS scores (tern_id TEXT NOT NULL REFERENCES terns(id), judge TEXT NOT NULL,
     score REAL NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS summaries (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', thread_id TEXT NOT NULL,
     bundle TEXT NOT NULL, from_tern TEXT NOT NULL, to_tern TEXT NOT NULL,
     from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, turns INTEGER NOT NULL, text TEXT NOT NULL,
     cost_usd REAL NOT NULL, created_at TEXT NOT NULL, compaction TEXT NOT NULL DEFAULT '',
     FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id));
   CREATE INDEX IF NOT EXISTS summaries_thread ON summaries(tenant_id, thread_id, to_seq);
   CREATE INDEX IF NOT EXISTS summaries_compaction ON summaries(tenant_id, thread_id, compaction, to_seq);
   CREATE TABLE IF NOT EXISTS config_versions (bundle TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL,
     snapshot TEXT NOT NULL, first_seen TEXT NOT NULL, PRIMARY KEY (bundle, version, hash));
   CREATE TABLE IF NOT EXISTS pause_answers (tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
     step_key TEXT NOT NULL, asked_at TEXT NOT NULL, record TEXT NOT NULL,
     PRIMARY KEY (tenant_id, root_execution_id, step_key));
   CREATE INDEX IF NOT EXISTS pause_answers_by_root ON pause_answers(tenant_id, root_execution_id);`,
];

const TurnRow = z.object({
  id: z.string(),
  run_id: z.string().nullable(),
  thread_id: z.string(),
  tenant_id: z.string(),
  bundle: z.string(),
  created_at: z.string(),
  task: z.string(),
  replyWith: z.string(),
  status: z.enum(TURN_STATUSES),
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

/**
 * Free text — a task, an answer, a summary — as its column keeps it (#521): JSON text, where a NUL
 * character is the escape `\u0000`, since node:sqlite reads a TEXT value only up to a NUL.
 */
export const storedTextOf = (text: string): string => JSON.stringify(text);

/** The ids of the row a text is read from, named by an unreadable refusal (never the text). */
type StoredIds = Readonly<Record<string, string | undefined>>;

/** The free text a column keeps (`storedTextOf`). */
export const textOf = (stored: string, what: string, ids: StoredIds): string =>
  z.string().parse(parsedStoredJson(what, stored, ids));

/** A database row → a typed Turn; rows are validated, never trusted. */
export function toTurn(row: unknown): Turn {
  const r = TurnRow.parse(row);
  const ids = { turnId: r.id, runId: r.run_id ?? undefined };
  return {
    id: r.id,
    runId: r.run_id,
    threadId: r.thread_id,
    tenantId: r.tenant_id,
    bundle: r.bundle,
    createdAt: r.created_at,
    task: textOf(r.task, "turn task", ids),
    replyWith: textOf(r.replyWith, "turn answer", ids),
    status: r.status,
    stopReason: textOf(r.stop_reason, "turn stop reason", ids),
    route: Route.parse(parsedStoredJson("turn route", r.route, ids)),
    steps: Steps.parse(parsedStoredJson("turn steps", r.steps, ids)),
    costUsd: r.cost_usd,
    promptVersion: r.prompt_version,
    modelVersion: r.model_version,
    replayOf: r.replay_of,
    configVersion: r.config_version,
    configHash: r.config_hash,
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

/** Migrates the Turn tables of an open database (a connection shared with other stores, #265). */
export const migrateTurnDatabase = (db: DatabaseSync): void => {
  migrate(db);
};

/**
 * Opens (creating directories) and migrates the database. `node:sqlite` is loaded here, on first
 * use, so importing `@agboss/core` never loads it (#195).
 */
export function openTurnDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(",");
