import { Injectable } from "../components/decorators.js";
import { AGBossError } from "../core/errors.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";
import type { Milliseconds } from "../units/index.js";
import type { Clock } from "./clock.js";
import type { Expiry } from "./expiry.js";
import { isTerminalA2ATaskState, type A2ATaskRepository } from "./a2a-task.repository.js";

/**
 * Infrastructure (#859): the bytes of the files an application's A2A tasks take and give — one row
 * per file, keyed `(tenantId, fileId)`, immutable once saved (a retry, a lease takeover, a resend
 * read the same bytes), owned by the task whose execution it belongs to (`ownerId`, its id). The
 * recovery sweep removes a task's files once the task has been over for `@Application({ retention:
 * { a2aFiles } })` — never while it is not (a paused, `INPUT_REQUIRED` task keeps them) — and a
 * file whose task never came to be, once it is that old.
 *
 * Listed only in `@Application({ providers })`. With none listed (the built-in
 * `InlineA2AFileRepository`), a small file rides inline in the task's own records — the
 * checkpoint, the task's output — up to the tier the assembly allows (`[a2a.file-store-required]`
 * above 256 KB); `InMemoryA2AFileRepository` keeps them in the instance's memory,
 * `LocalDiskA2AFileRepository` in a folder of one host, `S3A2AFileRepository` in a bucket every
 * instance shares. A store of your own proves itself with `a2aFileContract`
 * (`@agboss/core/testing/contracts`).
 */

/** A file's key: its tenant and its id. */
export interface A2AFileKey {
  readonly tenantId: string;
  readonly fileId: string;
}

/** Whose a file is: its tenant and the task (its execution) it belongs to. */
export interface A2AFileOwner {
  readonly tenantId: string;
  readonly ownerId: string;
}

/** What is kept of a file besides its bytes. */
export interface A2AFileMetadata extends A2AFileKey {
  readonly ownerId: string;
  readonly mediaType: string;
  readonly filename?: string;
  /** The SHA-256 of its bytes, lower-case hex. */
  readonly sha256: string;
  readonly sizeBytes: number;
  /** When it was saved, on the application's `Clock`. */
  readonly createdAt: Date;
}

/** A file to save: its metadata and its bytes. */
export interface NewA2AFile extends A2AFileMetadata {
  readonly bytes: Uint8Array;
}

/** A save of a key already kept with other bytes: a file never changes (`a2a.file-conflict`). */
export class A2AFileConflictError extends AGBossError {
  static override readonly code = "a2a.file-conflict" as const;

  constructor(readonly fileId: string) {
    super("a file is saved once: another file is kept under this id");
  }
}

export abstract class A2AFileRepository {
  /** Where the store's rows live (#825): a single-host one is refused when leases are shared. */
  static readonly store: StoreDescriptor = { backend: undefined };

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * Keeps a file. Saving one already kept with the same bytes (its `sha256`) does nothing;
   * with others it throws `A2AFileConflictError`, the kept one unchanged.
   */
  abstract save(file: NewA2AFile): Promise<void>;

  /** A file's bytes; `undefined` for a key it does not keep (another tenant's too). */
  abstract findBytes(key: A2AFileKey): Promise<Uint8Array | undefined>;

  /** A file's metadata; `undefined` for a key it does not keep. */
  abstract findMetadata(key: A2AFileKey): Promise<A2AFileMetadata | undefined>;

  /**
   * The owners of files saved before `cutoff`, each once, in an order of the store's own that every
   * call keeps: the first `limit` (a whole number from 1, else `RangeError`) of those after `after`
   * — an owner the page before gave. What the sweep pages through, every page each look, and checks
   * against the tasks before removing anything, so an owner still kept never hides the ones after it.
   */
  abstract findOwnersByCreatedAtBefore(
    cutoff: Date,
    limit: number,
    after?: A2AFileOwner,
  ): Promise<readonly A2AFileOwner[]>;

  /** Removes every file of one owner. */
  abstract deleteByOwner(owner: A2AFileOwner): Promise<void>;
}

/**
 * The built-in default (#859): no store — a file's bytes ride inline in its descriptor, so in the
 * task's own records. The framework never saves into it; a call is a wiring bug.
 */
@Injectable()
export class InlineA2AFileRepository extends A2AFileRepository {
  static override readonly store: StoreDescriptor = { backend: "inline" };

  ping(): Promise<void> {
    return Promise.resolve();
  }

  save(): Promise<void> {
    return Promise.reject(new Error("no A2A file store is listed: files ride inline"));
  }

  findBytes(): Promise<Uint8Array | undefined> {
    return Promise.resolve(undefined);
  }

  findMetadata(): Promise<A2AFileMetadata | undefined> {
    return Promise.resolve(undefined);
  }

  findOwnersByCreatedAtBefore(): Promise<readonly A2AFileOwner[]> {
    return Promise.resolve([]);
  }

  deleteByOwner(): Promise<void> {
    return Promise.resolve();
  }
}

/** Whether a store keeps no file: the default, whose files ride inline. */
export const isInlineFileStore = (store: A2AFileRepository): boolean =>
  store instanceof InlineA2AFileRepository;

/** Whether two saves of one key are the same file. */
export const isSameFile = (kept: A2AFileMetadata, saved: A2AFileMetadata): boolean =>
  kept.sha256 === saved.sha256 && kept.sizeBytes === saved.sizeBytes;

/** A file's metadata without its bytes, as a store answers it. */
export const metadataOf = (file: A2AFileMetadata): A2AFileMetadata => ({
  tenantId: file.tenantId,
  fileId: file.fileId,
  ownerId: file.ownerId,
  mediaType: file.mediaType,
  ...(file.filename === undefined ? {} : { filename: file.filename }),
  sha256: file.sha256,
  sizeBytes: file.sizeBytes,
  createdAt: new Date(file.createdAt.getTime()),
});

/** The order owners are paged in: by tenant, then owner (code units, as `<` compares them). */
export const ownerOrderOf = (owner: A2AFileOwner): string =>
  `${owner.tenantId}\u0000${owner.ownerId}`;

/** A page's limit, checked: a whole number from 1, so a sweep's paging always ends. */
export function checkedPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(
      `a page of A2A file owners holds a whole number from 1, not ${String(limit)}`,
    );
  return limit;
}

/**
 * A page of owners from all a store found (an in-memory or local-disk store's order): each once, by
 * tenant then owner, after `after`, at most `limit`.
 */
export function ownerPageOf(
  found: Iterable<A2AFileOwner>,
  limit: number,
  after: A2AFileOwner | undefined,
): readonly A2AFileOwner[] {
  checkedPageLimit(limit);
  const byOrder = new Map<string, A2AFileOwner>();
  for (const { tenantId, ownerId } of found)
    byOrder.set(ownerOrderOf({ tenantId, ownerId }), { tenantId, ownerId });
  const from = after === undefined ? undefined : ownerOrderOf(after);
  return [...byOrder.entries()]
    .filter(([order]) => from === undefined || order > from)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([, owner]) => owner);
}

/** How many owners one page of the sweep checks. */
const OWNERS_PER_PAGE = 100;

/**
 * Two leases (#859): a file whose task does not exist after this was kept for a message that never
 * became a task (an accept that lost its race, or crashed): an orphan. Younger, its task may still
 * be being saved.
 */
const ORPHAN_AFTER = 60_000;

/** What the sweep of the files reads: the tasks, to tell which are over. */
export interface A2AFileExpirySources {
  readonly files: A2AFileRepository;
  readonly tasks: Pick<A2ATaskRepository, "findById">;
  readonly clock: Pick<Clock, "now">;
  readonly retention: Milliseconds;
  /** Owners per page of the listing (`OWNERS_PER_PAGE` by default). */
  readonly pageSize?: number;
}

/** Whether an owner's files may go at `cutoff`: its task over before it, or never a task. */
async function isExpired(
  sources: A2AFileExpirySources,
  owner: A2AFileOwner,
  cutoff: Date,
): Promise<boolean> {
  const task = await sources.tasks.findById({ tenantId: owner.tenantId, taskId: owner.ownerId });
  if (task === undefined) return true; // swept with its task, or an orphan older than the cutoff
  return isTerminalA2ATaskState(task.status.state) && task.statusAt.getTime() < cutoff.getTime();
}

/**
 * The recovery sweep's removal of A2A files (#859): of the owners with files older than the cutoff,
 * those whose task has been over since before it — a task not over keeps its files, however long
 * it waits — and those that never were a task, past `ORPHAN_AFTER` too.
 */
export const a2aFileExpiryOf = (sources: A2AFileExpirySources): Expiry => ({
  what: "the A2A tasks' files",
  remove: async (cutoff: Date) => {
    const orphanCutoff = Math.min(cutoff.getTime(), sources.clock.now().getTime() - ORPHAN_AFTER);
    const pageSize = sources.pageSize ?? OWNERS_PER_PAGE;
    // every page, each look: owners still kept never hide the ones after them
    for (let after: A2AFileOwner | undefined; ;) {
      const owners = await sources.files.findOwnersByCreatedAtBefore(
        new Date(orphanCutoff),
        pageSize,
        after,
      );
      for (const owner of owners)
        if (await isExpired(sources, owner, cutoff)) await sources.files.deleteByOwner(owner);
      if (owners.length < pageSize) return;
      after = owners.at(-1);
    }
  },
  retention: sources.retention,
});
