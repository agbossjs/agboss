/** Ordered schema migrations; `PRAGMA user_version` = how many are applied. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE threads (id TEXT PRIMARY KEY, bundle TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE terns (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), bundle TEXT NOT NULL,
     created_at TEXT NOT NULL, task TEXT NOT NULL, replyWith TEXT NOT NULL, status TEXT NOT NULL,
     stop_reason TEXT NOT NULL, route TEXT NOT NULL, steps TEXT NOT NULL, cost_usd REAL NOT NULL,
     prompt_version TEXT NOT NULL, model_version TEXT NOT NULL, replay_of TEXT);
   CREATE INDEX terns_thread ON terns(thread_id);
   CREATE INDEX terns_version ON terns(bundle, prompt_version);
   CREATE TABLE scores (tern_id TEXT NOT NULL REFERENCES terns(id), judge TEXT NOT NULL,
     score REAL NOT NULL, created_at TEXT NOT NULL);`,
  // 2 — reasoning attempts (#79)
  `ALTER TABLE terns ADD COLUMN attempts TEXT NOT NULL DEFAULT '[]';`,
  // 3 — conversation memory: summaries of compacted turns (#77)
  `CREATE TABLE summaries (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), bundle TEXT NOT NULL,
     from_tern TEXT NOT NULL, to_tern TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
     turns INTEGER NOT NULL, text TEXT NOT NULL, cost_usd REAL NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX summaries_thread ON summaries(thread_id, to_seq);`,
  // 4 — readable config versions and their snapshots (#78)
  `ALTER TABLE terns ADD COLUMN config_version TEXT;
   ALTER TABLE terns ADD COLUMN config_hash TEXT;
   CREATE TABLE config_versions (bundle TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL,
     snapshot TEXT NOT NULL, first_seen TEXT NOT NULL, PRIMARY KEY (bundle, version, hash));`,
  // 5 — the reasoning attempts are gone (#150): their column is dropped, old rows stay readable
  `ALTER TABLE terns DROP COLUMN attempts;`,
  // 6 — paused runs survive a restart, with the versions they paused under (#201)
  `CREATE TABLE IF NOT EXISTS paused_runs (thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, run TEXT NOT NULL,
     workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, paused_at TEXT NOT NULL);`,
  // 7 — a thread belongs to the owner it was created for (#202); older threads have none
  `CREATE TABLE IF NOT EXISTS thread_owners (thread_id TEXT PRIMARY KEY REFERENCES threads(id),
     owner TEXT NOT NULL);`,
  // 8 — a Tern names the run that wrote it (#238); older Terns have none
  `ALTER TABLE terns ADD COLUMN run_id TEXT;`,
  // 9 — recovery looks up the records still running (#265 S30)
  `CREATE INDEX IF NOT EXISTS terns_status ON terns(status);`,
  // 10 — a thread belongs to its tenant (#261): its key is tenant + thread; older rows are "default"
  `ALTER TABLE threads ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';
   ALTER TABLE terns ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';`,
  // 11 — a caller may pick its own thread id (#262 Q4): a thread is unique by (tenant_id, id), and
  // every table of a thread names both. The tables are rebuilt (SQLite cannot change a key in
  // place); every row keeps its id, its tenant and its rowid (summaries count turns by rowid).
  `CREATE TABLE threads_v11 (id TEXT NOT NULL, bundle TEXT NOT NULL, created_at TEXT NOT NULL,
     tenant_id TEXT NOT NULL DEFAULT 'default', PRIMARY KEY (tenant_id, id));
   INSERT INTO threads_v11 (id, bundle, created_at, tenant_id)
     SELECT id, bundle, created_at, tenant_id FROM threads;
   CREATE TABLE thread_owners_v11 (tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL,
     owner TEXT NOT NULL, PRIMARY KEY (tenant_id, thread_id),
     FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id));
   INSERT INTO thread_owners_v11 (tenant_id, thread_id, owner)
     SELECT t.tenant_id, o.thread_id, o.owner FROM thread_owners o JOIN threads t ON t.id = o.thread_id;
   CREATE TABLE terns_v11 (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bundle TEXT NOT NULL,
     created_at TEXT NOT NULL, task TEXT NOT NULL, replyWith TEXT NOT NULL, status TEXT NOT NULL,
     stop_reason TEXT NOT NULL, route TEXT NOT NULL, steps TEXT NOT NULL, cost_usd REAL NOT NULL,
     prompt_version TEXT NOT NULL, model_version TEXT NOT NULL, replay_of TEXT,
     config_version TEXT, config_hash TEXT, run_id TEXT, tenant_id TEXT NOT NULL DEFAULT 'default',
     FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id));
   INSERT INTO terns_v11 (rowid, id, thread_id, bundle, created_at, task, replyWith, status,
       stop_reason, route, steps, cost_usd, prompt_version, model_version, replay_of,
       config_version, config_hash, run_id, tenant_id)
     SELECT rowid, id, thread_id, bundle, created_at, task, replyWith, status, stop_reason, route,
       steps, cost_usd, prompt_version, model_version, replay_of, config_version, config_hash,
       run_id, tenant_id FROM terns;
   CREATE TABLE summaries_v11 (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', thread_id TEXT NOT NULL,
     bundle TEXT NOT NULL, from_tern TEXT NOT NULL, to_tern TEXT NOT NULL,
     from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, turns INTEGER NOT NULL, text TEXT NOT NULL,
     cost_usd REAL NOT NULL, created_at TEXT NOT NULL,
     FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id));
   INSERT INTO summaries_v11 SELECT s.id, t.tenant_id, s.thread_id, s.bundle, s.from_tern,
       s.to_tern, s.from_seq, s.to_seq, s.turns, s.text, s.cost_usd, s.created_at
     FROM summaries s JOIN threads t ON t.id = s.thread_id;
   DROP TABLE thread_owners;
   DROP TABLE summaries;
   DROP TABLE terns;
   DROP TABLE threads;
   ALTER TABLE threads_v11 RENAME TO threads;
   ALTER TABLE thread_owners_v11 RENAME TO thread_owners;
   ALTER TABLE terns_v11 RENAME TO terns;
   ALTER TABLE summaries_v11 RENAME TO summaries;
   CREATE INDEX terns_thread ON terns(tenant_id, thread_id);
   CREATE INDEX terns_version ON terns(bundle, prompt_version);
   CREATE INDEX terns_status ON terns(status);
   CREATE INDEX summaries_thread ON summaries(tenant_id, thread_id, to_seq);`,
  // 12 — who answered each pause of a tree, the permanent log behind record.pauses (#267 S107)
  `CREATE TABLE pause_answers (tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
     step_key TEXT NOT NULL, asked_at TEXT NOT NULL, record TEXT NOT NULL,
     PRIMARY KEY (tenant_id, step_key));
   CREATE INDEX pause_answers_by_root ON pause_answers(tenant_id, root_execution_id);`,
  // 13 — a thread has the summaries of each of its compactions (#120 PR 3); older rows have none
  `ALTER TABLE summaries ADD COLUMN compaction TEXT NOT NULL DEFAULT '';
   CREATE INDEX summaries_compaction ON summaries(tenant_id, thread_id, compaction, to_seq);`,
  // 14 — free text is kept as JSON text (#521): node:sqlite reads a TEXT value only up to a NUL
  `UPDATE terns SET task = json_quote(task), replyWith = json_quote(replyWith),
     stop_reason = json_quote(stop_reason);
   UPDATE summaries SET text = json_quote(text);`,
  // 15 — one answer per pause of a tree (#676): a step key names no tree, and two trees whose ids
  // repeat (#663) share one. Rebuilt (SQLite cannot change a key in place), every row and rowid kept
  `CREATE TABLE pause_answers_v15 (tenant_id TEXT NOT NULL, root_execution_id TEXT NOT NULL,
     step_key TEXT NOT NULL, asked_at TEXT NOT NULL, record TEXT NOT NULL,
     PRIMARY KEY (tenant_id, root_execution_id, step_key));
   INSERT INTO pause_answers_v15 (rowid, tenant_id, root_execution_id, step_key, asked_at, record)
     SELECT rowid, tenant_id, root_execution_id, step_key, asked_at, record FROM pause_answers;
   DROP TABLE pause_answers;
   ALTER TABLE pause_answers_v15 RENAME TO pause_answers;
   CREATE INDEX pause_answers_by_root ON pause_answers(tenant_id, root_execution_id);`,
];
