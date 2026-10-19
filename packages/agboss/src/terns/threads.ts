import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TernStore } from "./types.js";

/** A new thread id; random by default, deterministic in tests. */
export type NewThreadId = () => string;

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;

/** Threads, their owners and their tenants (#202, #261 S72: a thread's key is tenant + thread). */
const OwnerRow = z.object({ owner: z.string().nullable() });

export function threadMethods(
  db: DatabaseSync,
  now: Now,
  newThreadId: NewThreadId,
): Pick<TernStore, "createThread" | "hasThread" | "threadOwner"> {
  return {
    // a caller's own id (#262 Q4) may be created twice at once: the first one keeps it
    createThread: ({ workflow, tenantId, ownerId, threadId }) => {
      const id = threadId ?? newThreadId();
      const { changes } = db
        .prepare(
          `INSERT INTO threads (id, bundle, created_at, tenant_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(tenant_id, id) DO NOTHING`,
        )
        .run(id, workflow, now().toISOString(), tenantId);
      if (Number(changes) === 1 && ownerId !== undefined) {
        db.prepare("INSERT INTO thread_owners (tenant_id, thread_id, owner) VALUES (?, ?, ?)").run(
          tenantId,
          id,
          ownerId,
        );
      }
      return Promise.resolve(id);
    },
    threadOwner: (bundle, tenantId, threadId) => {
      const row = db
        .prepare(
          `SELECT o.owner FROM threads t
           LEFT JOIN thread_owners o ON o.tenant_id = t.tenant_id AND o.thread_id = t.id
           WHERE t.tenant_id = ? AND t.id = ? AND t.bundle = ?`,
        )
        .get(tenantId, threadId, bundle);
      if (row === undefined) return Promise.resolve(undefined);
      const { owner } = OwnerRow.parse(row);
      return Promise.resolve({ owner: owner ?? undefined });
    },
    hasThread: (bundle, tenantId, threadId) => {
      const row = db
        .prepare("SELECT 1 FROM threads WHERE tenant_id = ? AND id = ? AND bundle = ?")
        .get(tenantId, threadId, bundle);
      return Promise.resolve(row !== undefined);
    },
  };
}
