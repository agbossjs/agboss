import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { placeholders } from "./schema.js";
import type { StatusLog } from "./status-log.js";
import type { EndedRun, TurnStore } from "./types.js";

/**
 * The sweep of idle threads (#1303c): a thread whose memory's `ttl` has run out since its last
 * activity is emptied of its Turns, summaries and pause answers — never while a tree of it is live or
 * paused. An owned thread stays as a tombstone (its row and owner, marked swept): no other owner can
 * take the id and read what anything else keyed by it still holds; the owner may restart on it.
 * A thread with no owner goes whole. Each thread is decided on its own, so one that came back to life keeps its rows.
 */

/** How many threads of one workflow one look removes: the rest go at the next look. */
const THREADS_PER_LOOK = 100;

/** How many threads of one workflow one look reads (kept or removed): bounds a look's work. */
const SCANNED_PER_LOOK = 1000;

/** The statuses of a Turn whose execution may still move: its thread is never removed. */
const LIVE_STATUSES = ["running", "paused", "queued"] as const;

const ThreadKey = z.object({ tenant_id: z.string(), id: z.string(), last_active_at: z.string() });
const RunRow = z.object({ run_id: z.string() });

interface IdleThread {
  readonly tenantId: string;
  readonly threadId: string;
  readonly lastActiveAt: string;
}

/**
 * The threads of `workflow` idle since before `cutoff`, longest idle first, the ones after `after`
 * (a keyset cursor: a look pages past the threads it kept, so they never hide the ones behind them).
 */
function idleThreadsOf(
  db: DatabaseSync,
  workflow: string,
  cutoff: Date,
  after: IdleThread | undefined,
): IdleThread[] {
  const cursor =
    after === undefined
      ? { sql: "", args: [] }
      : {
          sql: "AND (last_active_at, tenant_id, id) > (?, ?, ?)",
          args: [after.lastActiveAt, after.tenantId, after.threadId],
        };
  return db
    .prepare(
      `SELECT tenant_id, id, last_active_at FROM threads
       WHERE bundle = ? AND is_swept = 0 AND last_active_at < ? ${cursor.sql}
       ORDER BY last_active_at, tenant_id, id LIMIT ?`,
    )
    .all(workflow, cutoff.toISOString(), ...cursor.args, THREADS_PER_LOOK)
    .map((row) => {
      const key = ThreadKey.parse(row);
      return { tenantId: key.tenant_id, threadId: key.id, lastActiveAt: key.last_active_at };
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
function deleteRowsOf(
  db: DatabaseSync,
  thread: IdleThread,
  runs: readonly string[],
  log: StatusLog,
): void {
  const { tenantId, threadId } = thread;
  // the status history goes with the thread (#1341d): none stays orphaned
  log.forgotten(thread);
  db.prepare(
    `DELETE FROM scores WHERE tern_id IN (SELECT id FROM terns WHERE tenant_id = ? AND thread_id = ?)`,
  ).run(tenantId, threadId);
  if (runs.length > 0)
    db.prepare(
      `DELETE FROM pause_answers WHERE tenant_id = ? AND root_execution_id IN (${placeholders(runs.length)})`,
    ).run(tenantId, ...runs);
  db.prepare("DELETE FROM summaries WHERE tenant_id = ? AND thread_id = ?").run(tenantId, threadId);
  db.prepare("DELETE FROM terns WHERE tenant_id = ? AND thread_id = ?").run(tenantId, threadId);
  // a thread with an owner stays as a tombstone: the id is never another owner's to claim
  // (a different owner is refused at the owner check; the same owner restarts on an empty thread)
  const isOwned =
    db
      .prepare("SELECT 1 FROM thread_owners WHERE tenant_id = ? AND thread_id = ?")
      .get(tenantId, threadId) !== undefined;
  if (isOwned) {
    db.prepare("UPDATE threads SET is_swept = 1 WHERE tenant_id = ? AND id = ?").run(
      tenantId,
      threadId,
    );
    return;
  }
  db.prepare("DELETE FROM threads WHERE tenant_id = ? AND id = ?").run(tenantId, threadId);
}

/**
 * Removes the thread in one write transaction — only if it is still idle past the cutoff and has no
 * Turn of a live status (read inside the transaction: a Turn written since is never lost).
 */
function removeThread(
  db: DatabaseSync,
  thread: IdleThread,
  options: {
    readonly workflow: string;
    readonly cutoff: Date;
    readonly runs: readonly string[];
    readonly log: StatusLog;
  },
): boolean {
  const { tenantId, threadId } = thread;
  const { workflow, cutoff, runs, log } = options;
  db.exec("BEGIN IMMEDIATE");
  try {
    const stillIdle = db
      .prepare(
        `SELECT 1 FROM threads t WHERE t.tenant_id = ? AND t.id = ? AND t.bundle = ?
         AND t.is_swept = 0 AND t.last_active_at < ?
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
    deleteRowsOf(db, thread, runs, log);
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

/**
 * How a group of the sweep's statements runs (#1317): on the application's shared SQLite connection
 * it is served by the connection's gate (`connection.serve`), since each group after an `await` of
 * `isEnded` is past what the gate of the sweep's call covers; on a file of the store's own, at once.
 */
export type ServedStatements = <TValue>(work: () => TValue) => Promise<Awaited<TValue>>;

/** A file of the store's own: nothing else queues for it, each group runs at once. */
export const AT_ONCE: ServedStatements = (work) => Promise.resolve(work());

export function idleThreadMethods(
  db: DatabaseSync,
  log: StatusLog,
  served: ServedStatements = AT_ONCE,
): Pick<TurnStore, "deleteIdleThreads"> {
  // where the last look of a workflow stopped: the next one goes on from there, so threads a look
  // kept (a paused run, a live tree) cannot starve the idle ones behind them; the end wraps round
  const resumeAt = new Map<string, IdleThread>();
  /** One look at one workflow: pages from its cursor until it removed enough or read enough. */
  const lookAt = async (workflow: string, cutoff: Date, isEnded: EndedRun): Promise<number> => {
    let removed = 0;
    let scanned = 0;
    let after = resumeAt.get(workflow);
    while (removed < THREADS_PER_LOOK && scanned < SCANNED_PER_LOOK) {
      const from = after;
      const page = await served(() => idleThreadsOf(db, workflow, cutoff, from));
      for (const thread of page) {
        const runs = await served(() => runsOf(db, thread));
        if (!(await isThreadEnded(runs, thread.tenantId, isEnded))) continue;
        const options = { workflow, cutoff, runs, log };
        if (await served(() => removeThread(db, thread, options))) removed += 1;
      }
      scanned += page.length;
      if (page.length < THREADS_PER_LOOK) {
        resumeAt.delete(workflow);
        return removed;
      }
      after = page[page.length - 1];
      if (after !== undefined) resumeAt.set(workflow, after);
    }
    return removed;
  };
  return {
    deleteIdleThreads: async (cutoffs, isEnded) => {
      let removed = 0;
      for (const [workflow, cutoff] of cutoffs) removed += await lookAt(workflow, cutoff, isEnded);
      return removed;
    },
  };
}
