import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TernStore } from "./types.js";

/** A new thread id; random by default, deterministic in tests. */
export type NewThreadId = () => string;

type Clock = () => Date;

/** Threads, their owners and their tenants (#202, #261: a thread's key is tenant + thread). */
const OwnerRow = z.object({ owner: z.string().nullable() });

export function threadMethods(
  db: DatabaseSync,
  now: Clock,
  newThreadId: NewThreadId,
): Pick<TernStore, "createThread" | "hasThread" | "threadOwner"> {
  return {
    createThread: (bundle, tenantId, owner) => {
      const id = newThreadId();
      db.prepare("INSERT INTO threads (id, bundle, created_at, tenant_id) VALUES (?, ?, ?, ?)").run(
        id,
        bundle,
        now().toISOString(),
        tenantId,
      );
      if (owner !== undefined) {
        db.prepare("INSERT INTO thread_owners VALUES (?, ?)").run(id, owner);
      }
      return Promise.resolve(id);
    },
    threadOwner: (bundle, tenantId, threadId) => {
      const row = db
        .prepare(
          `SELECT o.owner FROM threads t LEFT JOIN thread_owners o ON o.thread_id = t.id
           WHERE t.id = ? AND t.bundle = ? AND t.tenant_id = ?`,
        )
        .get(threadId, bundle, tenantId);
      if (row === undefined) return Promise.resolve(undefined);
      const { owner } = OwnerRow.parse(row);
      return Promise.resolve({ owner: owner ?? undefined });
    },
    hasThread: (bundle, tenantId, threadId) => {
      const row = db
        .prepare("SELECT 1 FROM threads WHERE id = ? AND bundle = ? AND tenant_id = ?")
        .get(threadId, bundle, tenantId);
      return Promise.resolve(row !== undefined);
    },
  };
}
