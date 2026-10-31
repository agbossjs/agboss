import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TernStore } from "./types.js";

/** Where new thread ids come from: the application's `IdGenerator` (#313); random by default. */
export interface ThreadIds {
  newThreadId(): string;
}

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;

/** Threads, their owners and their tenants (#202, #261 S72: a thread's key is tenant + thread). */
const OwnerRow = z.object({ owner: z.string().nullable() });

/** How many minted ids a new thread tries before it gives up (#550). */
const MINTED_THREAD_TRIES = 100;

/** A minted id the tenant has no thread of, inserted by `insert` (`false`: taken, mint again). */
function mintedThreadId(threadIds: ThreadIds, insert: (id: string) => boolean): string {
  for (let tries = 0; tries < MINTED_THREAD_TRIES; tries += 1) {
    const id = threadIds.newThreadId();
    if (insert(id)) return id;
  }
  throw new Error(
    `no new thread id after ${String(MINTED_THREAD_TRIES)} minted ids: every one is a thread the tenant has — the IdGenerator repeats its ids`,
  );
}

export function threadMethods(
  db: DatabaseSync,
  now: Now,
  threadIds: ThreadIds,
): Pick<TernStore, "createThread" | "hasThread" | "threadOwner"> {
  return {
    // a caller's own id (#262 Q4) may be created twice at once: the first one keeps it; a minted
    // one that the tenant has already (#550: ids minted from 1 again on a shared database) is
    // never handed out — the next one is minted
    createThread: ({ workflow, tenantId, ownerId, threadId }) => {
      const insert = (id: string): boolean => {
        const { changes } = db
          .prepare(
            `INSERT INTO threads (id, bundle, created_at, tenant_id) VALUES (?, ?, ?, ?)
             ON CONFLICT(tenant_id, id) DO NOTHING`,
          )
          .run(id, workflow, now().toISOString(), tenantId);
        return Number(changes) === 1;
      };
      const id = threadId ?? mintedThreadId(threadIds, insert);
      const isCreated = threadId === undefined || insert(id);
      if (isCreated && ownerId !== undefined) {
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
