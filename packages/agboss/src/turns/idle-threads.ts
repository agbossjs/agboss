import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { placeholders } from "./schema.js";
import type { EndedRun, TurnStore } from "./types.js";

/**
 * The sweep of idle threads (#1303c): a thread whose memory's `ttl` has run out since its last
 * activity is removed with its Turns, summaries, owner and pause answers — never while a tree of it
 * is live or paused. Each thread is decided on its own, so one that came back to life keeps its rows.
 */

/** How many threads of one workflow one look removes: the rest go at the next look. */
const THREADS_PER_LOOK = 100;

/** The statuses of a Turn whose execution may still move: its thread is never removed. */
const LIVE_STATUSES = ["running", "paused", "queued"] as const;

const ThreadKey = z.object({ tenant_id: z.string(), id: z.string() });
const RunRow = z.object({ run_id: z.string() });

interface IdleThread {
  readonly tenantId: string;
  readonly threadId: string;
}

/** The threads of `workflow` idle since before `cutoff`, longest idle first. */
function idleThreadsOf(db: DatabaseSync, workflow: string, cutoff: Date): IdleThread[] {
  return db
    .prepare(
      `SELECT tenant_id, id FROM threads WHERE bundle = ? AND last_active_at < ?
       ORDER BY last_active_at LIMIT ?`,
    )
    .all(workflow, cutoff.toISOString(), THREADS_PER_LOOK)
    .map((row) => {
      const key = ThreadKey.parse(row);
      return { tenantId: key.tenant_id, threadId: key.id };
    });
}

/** The runs that wrote a Turn of the thread. */
const runsOf = (db: DatabaseSync, { tenantId, threadId }: IdleThread): string[] =>
  db
    .prepare(
      `SELECT DISTINCT run_id FROM terns WHERE tenant_id = ? AND thread_id = ? AND run_id IS NOT NULL`,
    )
    .all(tenantId, threadId)
    .map((row) => RunRow.parse(row).run_id);

/** The thread's rows in every table, children first (the caller's transaction holds them all). */
function deleteRowsOf(db: DatabaseSync, thread: IdleThread, runs: readonly string[]): void {
  const { tenantId, threadId } = thread;
  db.prepare(
    `DELETE FROM scores WHERE tern_id IN (SELECT id FROM terns WHERE tenant_id = ? AND thread_id = ?)`,
  ).run(tenantId, threadId);
  if (runs.length > 0)
    db.prepare(
      `DELETE FROM pause_answers WHERE tenant_id = ? AND root_execution_id IN (${placeholders(runs.length)})`,
    ).run(tenantId, ...runs);
  db.prepare("DELETE FROM summaries WHERE tenant_id = ? AND thread_id = ?").run(tenantId, threadId);
  db.prepare("DELETE FROM terns WHERE tenant_id = ? AND thread_id = ?").run(tenantId, threadId);
  db.prepare("DELETE FROM thread_owners WHERE tenant_id = ? AND thread_id = ?").run(
    tenantId,
    threadId,
  );
  db.prepare("DELETE FROM threads WHERE tenant_id = ? AND id = ?").run(tenantId, threadId);
}

/**
 * Removes the thread in one write transaction — only if it is still idle past the cutoff and has no
 * Turn of a live status (read inside the transaction: a Turn written since is never lost).
 */
function removeThread(
  db: DatabaseSync,
  thread: IdleThread,
  options: { readonly workflow: string; readonly cutoff: Date; readonly runs: readonly string[] },
): boolean {
  const { tenantId, threadId } = thread;
  const { workflow, cutoff, runs } = options;
  db.exec("BEGIN IMMEDIATE");
  try {
    const stillIdle = db
      .prepare(
        `SELECT 1 FROM threads t WHERE t.tenant_id = ? AND t.id = ? AND t.bundle = ?
         AND t.last_active_at < ?
         AND NOT EXISTS (SELECT 1 FROM terns x WHERE x.tenant_id = t.tenant_id AND x.thread_id = t.id
           AND x.status IN (${placeholders(LIVE_STATUSES.length)}))
         AND NOT EXISTS (SELECT 1 FROM terns y WHERE y.tenant_id = t.tenant_id AND y.thread_id = t.id
           AND y.run_id IS NOT NULL AND y.run_id NOT IN (${placeholders(Math.max(runs.length, 1))}))`,
      )
      .get(
        tenantId,
        threadId,
        workflow,
        cutoff.toISOString(),
        ...LIVE_STATUSES,
        ...(runs.length === 0 ? [""] : runs),
      );
    if (stillIdle === undefined) {
      db.exec("ROLLBACK");
      return false;
    }
    deleteRowsOf(db, thread, runs);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** Whether every run of the thread ended: one asked once, a live or unknown one keeps the thread. */
async function isThreadEnded(
  runs: readonly string[],
  tenantId: string,
  isEnded: EndedRun,
): Promise<boolean> {
  for (const runId of runs)
    if (!(await isEnded({ tenantId, rootExecutionId: runId }))) return false;
  return true;
}

export function idleThreadMethods(db: DatabaseSync): Pick<TurnStore, "deleteIdleThreads"> {
  return {
    deleteIdleThreads: async (cutoffs, isEnded) => {
      let removed = 0;
      for (const [workflow, cutoff] of cutoffs) {
        for (const thread of idleThreadsOf(db, workflow, cutoff)) {
          const runs = runsOf(db, thread);
          if (!(await isThreadEnded(runs, thread.tenantId, isEnded))) continue;
          if (removeThread(db, thread, { workflow, cutoff, runs })) removed += 1;
        }
      }
      return removed;
    },
  };
}
