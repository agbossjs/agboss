import type { DatabaseSync } from "node:sqlite";
import { CHECKPOINT_TABLES, STEP_INDEX, UNREADABLE_STEP_INDEX } from "./sqlite-checkpoint-rows.js";
import { DIRECT_SCHEMA } from "./sqlite-a2a-direct-message-rows.js";
import { SCHEMA as A2A_TASKS_SCHEMA } from "./sqlite-a2a-task-rows.js";
import { STATUS_TRANSITIONS_SCHEMA } from "../../turns/index.js";
import { EXECUTION_LEASES_SCHEMA } from "./sqlite-lease-schema.js";
import { OUTBOUND_CALLS_SCHEMA } from "./sqlite-outbound-call-schema.js";
import { NOTICES_SCHEMA, PAUSED_RUNS_SCHEMA, PAUSES_SCHEMA } from "./sqlite-pause-schema.js";
import {
  AUDIT_EVENTS_SCHEMA,
  CHILD_QUEUE_SCHEMA,
  COST_LEDGER_SCHEMA,
  EXECUTION_HISTORY_SCHEMA,
  EXECUTION_IDS_SCHEMA,
  EXECUTION_TREE_SCHEMA,
  FENCED_EFFECTS_SCHEMA,
  MESH_REQUESTS_SCHEMA,
  RATE_LIMIT_SLOTS_SCHEMA,
  RATE_LIMIT_WINDOWS_SCHEMA,
} from "./sqlite-tables.js";

/**
 * Every table and index of the 0.1.1 SQLite schema, in one place — the 0.1.1 baseline. Each
 * statement is `CREATE … IF NOT EXISTS`, so it is idempotent and keyed by the file's shape (never
 * by the stamp of `agboss_schema`): a run again, a crash half way and two processes opening one
 * file all end in the same schema. A later release that changes a table adds a shape-keyed step
 * here (a `PRAGMA table_info` / `sqlite_master` check inside the same transaction), never a branch
 * in a repository. A file a 0.1.0 build wrote is not read or migrated.
 */
const BASELINE_DDL: readonly string[] = [
  EXECUTION_LEASES_SCHEMA,
  STATUS_TRANSITIONS_SCHEMA,
  EXECUTION_IDS_SCHEMA,
  FENCED_EFFECTS_SCHEMA,
  OUTBOUND_CALLS_SCHEMA,
  AUDIT_EVENTS_SCHEMA,
  CHECKPOINT_TABLES,
  `${STEP_INDEX};\n${UNREADABLE_STEP_INDEX};`,
  PAUSED_RUNS_SCHEMA,
  PAUSES_SCHEMA,
  NOTICES_SCHEMA,
  COST_LEDGER_SCHEMA,
  CHILD_QUEUE_SCHEMA,
  EXECUTION_HISTORY_SCHEMA,
  EXECUTION_TREE_SCHEMA,
  MESH_REQUESTS_SCHEMA,
  RATE_LIMIT_SLOTS_SCHEMA,
  RATE_LIMIT_WINDOWS_SCHEMA,
  A2A_TASKS_SCHEMA,
  DIRECT_SCHEMA,
];

/**
 * Creates the whole baseline schema on `database`, in one `BEGIN IMMEDIATE` transaction taken
 * first, so of two connections one creates and the other finds it done. Run by `SqliteConnection`
 * when it opens, before any repository is built: a store never creates a table of its own.
 */
export function ensureBaselineSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const ddl of BASELINE_DDL) database.exec(ddl);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The tables the baseline creates: what `checkedSchemaVersion` asks a file about — a file holding
 * any of them is not new. A test creates the baseline and compares this list with the file's
 * tables, so it cannot drift from the DDL above.
 */
export const BASELINE_TABLES: readonly string[] = [
  "a2a_direct_messages",
  "a2a_messages",
  "a2a_tasks",
  "checkpoint_writes",
  "checkpoints",
  "child_execution_queue",
  "cost_ledger",
  "cost_ledger_entries",
  "cost_ledger_entries_pruned",
  "cost_ledger_max_spend",
  "execution_history",
  "execution_ids",
  "execution_lease_events",
  "execution_leases",
  "execution_tree_keys",
  "fenced_effect_business_results",
  "fenced_effect_marks",
  "fenced_effect_results",
  "mesh_requests",
  "outbound_calls",
  "pause_notices",
  "paused_executions",
  "pauses",
  "rate_limit_pauses",
  "rate_limit_slots",
  "rate_limit_window_entries",
  "thread_status_transitions",
];
