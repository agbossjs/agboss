/**
 * The baseline 0.1.1 tables of a SQLite file whose stores keep their DDL out of the repositories: one
 * `CREATE … IF NOT EXISTS` string each, run by `ensureBaselineSchema` when the connection opens
 * (`sqlite-baseline-schema.ts`). Edited in place — there are no migration steps (0.1.0 has no users).
 */

export const RATE_LIMIT_SLOTS_SCHEMA = `CREATE TABLE IF NOT EXISTS rate_limit_slots (
  slot_id TEXT PRIMARY KEY, slot_key TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limit_slots_key ON rate_limit_slots(slot_key, expires_at);`;

/** The rate limiter's windows and pauses (#266 S58, #265 S52). */
export const RATE_LIMIT_WINDOWS_SCHEMA = `CREATE TABLE IF NOT EXISTS rate_limit_window_entries (
  window_key TEXT NOT NULL, counted_at INTEGER NOT NULL, amount REAL NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limit_window_entries_key
  ON rate_limit_window_entries(window_key, counted_at);
CREATE TABLE IF NOT EXISTS rate_limit_pauses (
  pause_key TEXT PRIMARY KEY, paused_until INTEGER NOT NULL);`;

export const AUDIT_EVENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_lease_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL, record TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS execution_lease_events_tree
  ON execution_lease_events (tenant_id, root_execution_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS execution_lease_events_occurred ON execution_lease_events (occurred_at);`;

export const CHILD_QUEUE_SCHEMA = `CREATE TABLE IF NOT EXISTS child_execution_queue (
  tenant_id TEXT NOT NULL, execution_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
  parent_execution_id TEXT NOT NULL, root_workflow TEXT NOT NULL, workflow TEXT NOT NULL,
  depth INTEGER NOT NULL, status TEXT NOT NULL, run TEXT NOT NULL, queued_at INTEGER NOT NULL,
  instance_id TEXT, claimed_at INTEGER, ended_at INTEGER, failure TEXT,
  PRIMARY KEY (tenant_id, execution_id));
CREATE INDEX IF NOT EXISTS child_execution_queue_claims
  ON child_execution_queue (status, depth DESC, queued_at);`;

export const MESH_REQUESTS_SCHEMA = `CREATE TABLE IF NOT EXISTS mesh_requests (
  tenant_id TEXT NOT NULL, peer TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL, response TEXT,
  PRIMARY KEY (tenant_id, peer, idempotency_key));`;

export const EXECUTION_HISTORY_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_history (
  tenant_id TEXT NOT NULL, execution_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, record TEXT NOT NULL,
  PRIMARY KEY (tenant_id, execution_id));
CREATE INDEX IF NOT EXISTS execution_history_started ON execution_history (started_at, execution_id);
CREATE INDEX IF NOT EXISTS execution_history_thread ON execution_history (tenant_id, thread_id);
CREATE INDEX IF NOT EXISTS execution_history_ended ON execution_history (ended_at);`;

export const EXECUTION_TREE_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_tree_keys (
  tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL, tree_key TEXT NOT NULL,
  value TEXT NOT NULL, PRIMARY KEY (tenant_id, root_execution_id, tree_key));`;

/** One counter per budget, scope key and period; the last `maxSpend()` per budget and scope key. */
export const COST_LEDGER_SCHEMA = `CREATE TABLE IF NOT EXISTS cost_ledger (
  budget TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, period TEXT NOT NULL,
  spent_usd REAL NOT NULL, PRIMARY KEY (budget, scope, scope_key, period));
CREATE TABLE IF NOT EXISTS cost_ledger_max_spend (
  budget TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL, max_spend_usd REAL NOT NULL,
  PRIMARY KEY (budget, scope, scope_key));
CREATE TABLE IF NOT EXISTS cost_ledger_entries (
  ledger_id TEXT NOT NULL PRIMARY KEY, made_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS cost_ledger_entries_made_at ON cost_ledger_entries (made_at);
CREATE TABLE IF NOT EXISTS cost_ledger_entries_pruned (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), pruned_before INTEGER NOT NULL);`;

/** The scopes' marks and the results (#500); the marks are every fenced store's of the file. */
export const FENCED_EFFECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS fenced_effect_marks (
  scope_key TEXT PRIMARY KEY, highest_token INTEGER NOT NULL, stored_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fenced_effect_results (
  scope_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, name TEXT NOT NULL,
  token INTEGER NOT NULL, stored_at INTEGER NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (scope_key, idempotency_key, name));
CREATE TABLE IF NOT EXISTS fenced_effect_business_results (
  tenant_id TEXT NOT NULL, name TEXT NOT NULL, business_key TEXT NOT NULL,
  token INTEGER NOT NULL, stored_at INTEGER NOT NULL, result TEXT NOT NULL, facts TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name, business_key));`;

/**
 * Every execution id handed out (#591), by the id alone, in the lease store's file: inserted once,
 * never removed.
 */
export const EXECUTION_IDS_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_ids (
  execution_id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL);`;
