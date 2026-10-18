import { z } from "zod";
import type { PausedRun } from "../../app/paused-runs.js";
import { Injectable } from "../../components/decorators.js";
import type { AgentExecutionOutput } from "../../run/types.js";
import { INFRASTRUCTURE_CLOCK } from "../clock.js";
import {
  PausedExecutionRepository,
  PauseStatus,
  resolvedPause,
} from "../paused-execution.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS paused_executions (
  thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, run TEXT NOT NULL,
  workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, status TEXT NOT NULL,
  decision TEXT, paused_at TEXT NOT NULL);`;

const PausedRow = z.object({
  run: z.string(),
  workflow_version: z.string(),
  config_hash: z.string(),
  status: z.enum(PauseStatus),
  decision: z.string().nullable(),
});

/** The fields a resume relies on; the rest of the stored run is passed through as written. */
const StoredRun = z.looseObject({
  status: z.literal("paused"),
  threadId: z.string(),
  runId: z.string(),
  ternId: z.string(),
  // Infinity when the run has no cost limit (z.number() rejects it)
  budgetUsd: z.custom<number>((value) => typeof value === "number" && !Number.isNaN(value)),
});

/** JSON keeps no `Infinity` (a run without a cost limit has `budgetUsd: Infinity`): tagged. */
const NonFinite = z.object({ $number: z.enum(["Infinity", "-Infinity", "NaN"]) });

const encode = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item,
  );

const decode = (text: string): unknown =>
  JSON.parse(text, (_key, item: unknown) => {
    const tagged = NonFinite.safeParse(item);
    return tagged.success ? Number(tagged.data.$number) : item;
  });

/** A decision as stored: JSON, or `NULL` for none. */
const encodedDecision = (decision: unknown): string | null =>
  decision === undefined ? null : encode(decision);

/** Whether a decoded run is what `save` wrote: an `AgentExecutionOutput` of a paused run. */
const isStoredRun = (value: unknown): value is AgentExecutionOutput =>
  StoredRun.safeParse(value).success;

function toPausedRun(row: unknown): PausedRun {
  const r = PausedRow.parse(row);
  const run = decode(r.run);
  if (!isStoredRun(run)) throw new Error(`a stored paused run is not readable: ${r.run}`);
  const paused: PausedRun = {
    run,
    workflowVersion: r.workflow_version,
    configHash: r.config_hash,
    status: r.status,
  };
  return r.decision === null ? paused : { ...paused, decision: decode(r.decision) };
}

/**
 * `PausedExecutionRepository` on the application's SQLite file (#265, S32): one row per thread —
 * the paused run, the versions it paused under, its status and decision. `resolveByThreadId` turns
 * `Pending` into `Resolved` in one `BEGIN IMMEDIATE` transaction, so of two resumes on two
 * instances exactly one records its decision. With `SqliteCheckpointSaver` a pause survives a
 * restart. Listed in `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, INFRASTRUCTURE_CLOCK] })
export class SqlitePausedExecutionRepository extends PausedExecutionRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly now: () => Date,
  ) {
    super();
    connection.ensureSchema("paused_executions", SCHEMA);
  }

  findByThreadId(threadId: string): Promise<PausedRun | undefined> {
    const row = this.connection.database
      .prepare("SELECT * FROM paused_executions WHERE thread_id = ?")
      .get(threadId);
    return Promise.resolve(row === undefined ? undefined : toPausedRun(row));
  }

  save(paused: PausedRun): Promise<void> {
    const { run } = paused;
    this.connection.database
      .prepare("INSERT OR REPLACE INTO paused_executions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        run.threadId,
        run.runId,
        encode(run),
        paused.workflowVersion,
        paused.configHash,
        paused.status,
        encodedDecision(paused.decision),
        this.now().toISOString(),
      );
    return Promise.resolve();
  }

  resolveByThreadId(threadId: string, decision: unknown): Promise<PausedRun | undefined> {
    const { database } = this.connection;
    const resolved = this.connection.transaction((): PausedRun | undefined => {
      const row = database
        .prepare("SELECT * FROM paused_executions WHERE thread_id = ? AND status = ?")
        .get(threadId, PauseStatus.Pending);
      if (row === undefined) return undefined;
      database
        .prepare("UPDATE paused_executions SET status = ?, decision = ? WHERE thread_id = ?")
        .run(PauseStatus.Resolved, encodedDecision(decision), threadId);
      return resolvedPause(toPausedRun(row), decision);
    });
    return Promise.resolve(resolved);
  }

  deleteByThreadId(threadId: string): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM paused_executions WHERE thread_id = ?")
      .run(threadId);
    return Promise.resolve();
  }
}

sqliteImplementation(SqlitePausedExecutionRepository);
