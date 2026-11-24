import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { storedTextOf, textOf } from "./schema.js";
import {
  StatusTrigger,
  ThreadStatus,
  transitionOf,
  type NewStatusTransition,
  type ThreadStatusTransition,
} from "./status-transition.js";

/**
 * Where a thread's status history is kept (#1341d): the SQLite table of the Turn database, or a
 * map in memory, shared by the in-memory stores of one application instance.
 */

/**
 * Where a store keeps a thread's history, inside the write transaction of the change (every method
 * is synchronous: the caller's transaction is open around it).
 */
export interface StatusLog {
  /** Appends `next` unless it changes nothing; the row written, or `undefined`. */
  readonly appended: (next: NewStatusTransition, at: Date) => ThreadStatusTransition | undefined;
  /** The thread's last row. */
  readonly lastOf: (thread: {
    readonly tenantId: string;
    readonly threadId: string;
  }) => ThreadStatusTransition | undefined;
  /** The thread's rows, oldest first. */
  readonly historyOf: (thread: {
    readonly tenantId: string;
    readonly threadId: string;
  }) => readonly ThreadStatusTransition[];
  /** Removes the thread's rows (its history's `historyTtl` ran out, or its tree was forgotten). */
  readonly forgotten: (thread: { readonly tenantId: string; readonly threadId: string }) => void;
}

const TransitionRow = z.object({
  tenant_id: z.string(),
  thread_id: z.string(),
  seq: z.number(),
  from_status: z.enum(ThreadStatus).nullable(),
  to_status: z.enum(ThreadStatus),
  trigger: z.enum(StatusTrigger),
  reason: z.string().nullable(),
  actor: z.string().nullable(),
  lease_token: z.number().nullable(),
  at: z.string(),
});

/** A stored row → a transition; the free text of a reason and an actor is read as it was kept. */
function transitionOfRow(row: unknown): ThreadStatusTransition {
  const r = TransitionRow.parse(row);
  const ids = { threadId: r.thread_id };
  const reason = r.reason === null ? undefined : textOf(r.reason, "status reason", ids);
  const actor = r.actor === null ? undefined : textOf(r.actor, "status actor", ids);
  return {
    tenantId: r.tenant_id,
    threadId: r.thread_id,
    seq: r.seq,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    trigger: r.trigger,
    ...(reason === undefined ? {} : { reason }),
    ...(actor === undefined ? {} : { actor }),
    ...(r.lease_token === null ? {} : { leaseToken: r.lease_token }),
    at: new Date(r.at),
  };
}

/** The history in the SQLite tables of `database`: the transaction around a call is the caller's. */
export function sqliteStatusLog(database: DatabaseSync): StatusLog {
  const lastOf: StatusLog["lastOf"] = ({ tenantId, threadId }) => {
    const row = database
      .prepare(
        `SELECT * FROM thread_status_transitions WHERE tenant_id = ? AND thread_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(tenantId, threadId);
    return row === undefined ? undefined : transitionOfRow(row);
  };
  return {
    lastOf,
    appended: (next, at) => {
      const written = transitionOf(next, lastOf(next), at);
      if (written === undefined) return undefined;
      const values: SQLInputValue[] = [
        written.tenantId,
        written.threadId,
        written.seq,
        written.fromStatus,
        written.toStatus,
        written.trigger,
        written.reason === undefined ? null : storedTextOf(written.reason),
        written.actor === undefined ? null : storedTextOf(written.actor),
        written.leaseToken ?? null,
        written.at.toISOString(),
      ];
      database
        .prepare(
          `INSERT INTO thread_status_transitions (tenant_id, thread_id, seq, from_status, to_status,
           trigger, reason, actor, lease_token, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...values);
      return written;
    },
    historyOf: ({ tenantId, threadId }) =>
      database
        .prepare(
          `SELECT * FROM thread_status_transitions WHERE tenant_id = ? AND thread_id = ? ORDER BY seq`,
        )
        .all(tenantId, threadId)
        .map(transitionOfRow),
    forgotten: ({ tenantId, threadId }) => {
      database
        .prepare(`DELETE FROM thread_status_transitions WHERE tenant_id = ? AND thread_id = ?`)
        .run(tenantId, threadId);
    },
  };
}

/** The history in memory, by `tenantId` + `threadId`: what the in-memory stores of one instance share. */
export function memoryStatusLog(rows: Map<string, ThreadStatusTransition[]>): StatusLog {
  const keyOf = ({ tenantId, threadId }: { tenantId: string; threadId: string }): string =>
    `${tenantId}\u0000${threadId}`;
  return {
    lastOf: (thread) => rows.get(keyOf(thread))?.at(-1),
    appended: (next, at) => {
      const key = keyOf(next);
      const kept = rows.get(key) ?? [];
      const written = transitionOf(next, kept.at(-1), at);
      if (written === undefined) return undefined;
      rows.set(key, [...kept, written]);
      return written;
    },
    historyOf: (thread) => rows.get(keyOf(thread)) ?? [],
    forgotten: (thread) => {
      rows.delete(keyOf(thread));
    },
  };
}
