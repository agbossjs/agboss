import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TurnStore } from "./types.js";

/** Where new thread ids come from: the application's `IdGenerator` (#313); random by default. */
export interface ThreadIds {
  newThreadId(): string;
  /** The error when `tries` minted ids were all the tenant's threads (#613); else a plain one. */
  exhausted?(tries: number): Error;
}

/** The current time (the application's clock, given by the caller). */
type Now = () => Date;

/** Threads, their owners and their tenants (#202, #261 S72: a thread's key is tenant + thread). */
const OwnerRow = z.object({ owner: z.string().nullable(), is_swept: z.number() });

/** How many minted ids a new thread tries before it gives up (#550). */
const MINTED_THREAD_TRIES = 100;

/**
 * A caller's own id the tenant already has: kept as it is (the first creator owns it, the caller's
 * owner check settles the rest, #262 Q4) — except a swept thread (#1303c), fail closed: a different
 * caller, or one naming no owner, is refused; its owner restarts it (the one place the tombstone is
 * cleared).
 */
function claimExisting(
  db: DatabaseSync,
  claim: { tenantId: string; threadId: string; ownerId: string | undefined; at: string },
): void {
  const { tenantId, threadId, ownerId, at } = claim;
  const row = db
    .prepare(
      `SELECT o.owner, t.is_swept FROM threads t
       LEFT JOIN thread_owners o ON o.tenant_id = t.tenant_id AND o.thread_id = t.id
       WHERE t.tenant_id = ? AND t.id = ?`,
    )
    .get(tenantId, threadId);
  if (row === undefined) return;
  const { owner, is_swept: isSwept } = OwnerRow.parse(row);
  if (isSwept !== 1) return;
  if (owner !== ownerId)
    throw new Error("the thread belongs to another owner: it is not created again");
  db.prepare(
    "UPDATE threads SET is_swept = 0, last_active_at = ? WHERE tenant_id = ? AND id = ?",
  ).run(at, tenantId, threadId);
}

/** A minted id the tenant has no thread of, inserted by `insert` (`false`: taken, mint again). */
function mintedThreadId(threadIds: ThreadIds, insert: (id: string) => boolean): string {
  for (let tries = 0; tries < MINTED_THREAD_TRIES; tries += 1) {
    const id = threadIds.newThreadId();
    if (insert(id)) return id;
  }
  throw (
    threadIds.exhausted?.(MINTED_THREAD_TRIES) ??
    new Error(
      `no new thread id after ${String(MINTED_THREAD_TRIES)} minted ids: every one is a thread the tenant has — the IdGenerator repeats its ids`,
    )
  );
}

/** A thread's owner and whether it is a swept tombstone (#1303c); `undefined`: no such thread. */
function threadOwnerOf(
  db: DatabaseSync,
  { bundle, tenantId, threadId }: { bundle: string; tenantId: string; threadId: string },
): Awaited<ReturnType<TurnStore["threadOwner"]>> {
  const row = db
    .prepare(
      `SELECT o.owner, t.is_swept FROM threads t
       LEFT JOIN thread_owners o ON o.tenant_id = t.tenant_id AND o.thread_id = t.id
       WHERE t.tenant_id = ? AND t.id = ? AND t.bundle = ?`,
    )
    .get(tenantId, threadId, bundle);
  if (row === undefined) return undefined;
  const { owner, is_swept: isSwept } = OwnerRow.parse(row);
  // a swept thread is the owner's emptied tombstone: only its owner may restart it
  return { owner: owner ?? undefined, ...(isSwept === 1 ? { isSwept: true as const } : {}) };
}

export function threadMethods(
  db: DatabaseSync,
  now: Now,
  threadIds: ThreadIds,
): Pick<TurnStore, "createThread" | "hasThread" | "threadOwner"> {
  return {
    // a caller's own id (#262 Q4) may be created twice at once: the first one keeps it; a minted
    // one that the tenant has already (#550: ids minted from 1 again on a shared database) is
    // never handed out — the next one is minted
    // in a promise's executor: a refused mint (#578, #613) rejects, never throws at the call
    createThread: ({ workflow, tenantId, ownerId, threadId }) =>
      new Promise<string>((resolve) => {
        const createdAt = now().toISOString();
        const insert = (id: string): boolean => {
          const { changes } = db
            .prepare(
              `INSERT INTO threads (id, bundle, created_at, tenant_id, last_active_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(tenant_id, id) DO NOTHING`,
            )
            .run(id, workflow, createdAt, tenantId, createdAt);
          return Number(changes) === 1;
        };
        const id = threadId ?? mintedThreadId(threadIds, insert);
        const isCreated = threadId === undefined || insert(id);
        if (!isCreated) claimExisting(db, { tenantId, threadId: id, ownerId, at: createdAt });
        if (isCreated && ownerId !== undefined) {
          db.prepare(
            "INSERT INTO thread_owners (tenant_id, thread_id, owner) VALUES (?, ?, ?)",
          ).run(tenantId, id, ownerId);
        }
        resolve(id);
      }),
    threadOwner: (bundle, tenantId, threadId) =>
      Promise.resolve(threadOwnerOf(db, { bundle, tenantId, threadId })),
    hasThread: (bundle, tenantId, threadId) => {
      const row = db
        .prepare("SELECT 1 FROM threads WHERE tenant_id = ? AND id = ? AND bundle = ?")
        .get(tenantId, threadId, bundle);
      return Promise.resolve(row !== undefined);
    },
  };
}
