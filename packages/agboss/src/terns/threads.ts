import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { threadKeyOf } from "./thread-key.js";
import type { TernStore } from "./types.js";

/** A new thread id; random by default, deterministic in tests. */
export type NewThreadId = () => string;

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;

/** Threads, their owners and their tenants (#202, #261: a thread's key is tenant + thread). */
const OwnerRow = z.object({ owner: z.string().nullable() });

export function threadMethods(
  db: DatabaseSync,
  now: Now,
  newThreadId: NewThreadId,
): Pick<TernStore, "createThread" | "hasThread" | "threadOwner"> {
  return {
    // a caller's own id (#262 Q4) may be created twice at once: the first one keeps it
    createThread: (bundle, tenantId, owner, threadId) => {
      const id = threadId ?? newThreadId();
      const key = threadKeyOf(tenantId, id);
      const { changes } = db
        .prepare(
          `INSERT INTO threads (id, bundle, created_at, tenant_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(key, bundle, now().toISOString(), tenantId);
      if (Number(changes) === 1 && owner !== undefined) {
        db.prepare("INSERT INTO thread_owners VALUES (?, ?)").run(key, owner);
      }
      return Promise.resolve(id);
    },
    threadOwner: (bundle, tenantId, threadId) => {
      const row = db
        .prepare(
          `SELECT o.owner FROM threads t LEFT JOIN thread_owners o ON o.thread_id = t.id
           WHERE t.id = ? AND t.bundle = ? AND t.tenant_id = ?`,
        )
        .get(threadKeyOf(tenantId, threadId), bundle, tenantId);
      if (row === undefined) return Promise.resolve(undefined);
      const { owner } = OwnerRow.parse(row);
      return Promise.resolve({ owner: owner ?? undefined });
    },
    hasThread: (bundle, tenantId, threadId) => {
      const row = db
        .prepare("SELECT 1 FROM threads WHERE id = ? AND bundle = ? AND tenant_id = ?")
        .get(threadKeyOf(tenantId, threadId), bundle, tenantId);
      return Promise.resolve(row !== undefined);
    },
  };
}
