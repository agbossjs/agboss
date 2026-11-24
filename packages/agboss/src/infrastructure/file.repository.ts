import { Injectable } from "../components/decorators.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";
import type { Bytes, Milliseconds } from "../units/index.js";

/**
 * Infrastructure (#859, #1316): the bytes of the files a workflow keeps — one row per file, keyed
 * `(tenantId, fileId)`, immutable once saved (a retry, a lease takeover, a resend read the same
 * bytes), owned by the root execution it belongs to (`ownerId`, its id). A file is kept while its
 * execution runs, however long, and for its `@FilePolicy` `ttl` (or the shorter one of its own) once
 * the execution's whole tree has ended: `markOwnerCompleted` says when, `deleteExpired` is the sweep.
 *
 * Listed only in `@Application({ providers })`. With none listed (the built-in
 * `InlineFileRepository`), a small file rides inline in the task's own records — the
 * checkpoint, the task's output — up to the tier the assembly allows (`[a2a.file-store-required]`
 * above 256 KB); `InMemoryFileRepository` keeps them in the instance's memory,
 * `LocalDiskFileRepository` in a folder of one host, `S3FileRepository` in a bucket every
 * instance shares. A store of your own proves itself with `fileContract`
 * (`@agboss/core/testing/contracts`).
 */

/** A file's key: its tenant and its id. */
export interface FileKey {
  readonly tenantId: string;
  readonly fileId: string;
}

/** Whose a file is: its tenant and the task (its execution) it belongs to. */
export interface FileOwner {
  readonly tenantId: string;
  readonly ownerId: string;
}

/** What is kept of a file besides its bytes. */
export interface FileMetadata extends FileKey {
  readonly ownerId: string;
  readonly mediaType: string;
  readonly filename?: string;
  /** The SHA-256 of its bytes, lower-case hex. */
  readonly sha256: string;
  readonly sizeBytes: Bytes;
  /** When it was saved, on the application's `Clock`. */
  readonly createdAt: Date;
  /**
   * How long it is kept once its owner has ended: the `ttl` of the policy it was saved under, or
   * the shorter one of its own (`Files.save({ ttl })`); `undefined`: its root workflow's
   * (`FileSweep.cutoffsByWorkflow`), a copy of a file made for a model included.
   */
  readonly ttl?: Milliseconds;
}

/** An owner whose execution has ended: its workflow and when. */
export interface FileOwnerCompletion extends FileOwner {
  readonly workflow: string;
  readonly completedAt: Date;
}

/** What one sweep of `deleteExpired` is given. */
export interface FileSweep {
  /** The moment of the sweep, on the application's `Clock`. */
  readonly now: Date;
  /**
   * Per root workflow with a finite `ttl`: `now - ttl`. An owner that completed before its workflow's
   * cutoff loses all its files. A workflow with no entry (`Ttl.Forever`) loses only the files that
   * carry a `ttl` of their own, and those at `completedAt + ttl < now`.
   */
  readonly cutoffsByWorkflow: ReadonlyMap<string, Date>;
}

/** A file to save: its metadata and its bytes. */
export interface NewFile extends FileMetadata {
  readonly bytes: Uint8Array;
}

export abstract class FileRepository {
  /** Where the store's rows live (#825): a single-host one is refused when leases are shared. */
  static readonly store: StoreDescriptor = { backend: undefined };

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * Keeps a file. Saving one already kept with the same bytes (its `sha256`) does nothing;
   * with others it throws `FileError.Conflict`, the kept one unchanged.
   */
  abstract save(file: NewFile): Promise<void>;

  /** A file's bytes; `undefined` for a key it does not keep (another tenant's too). */
  abstract findBytes(key: FileKey): Promise<Uint8Array | undefined>;

  /** A file's metadata; `undefined` for a key it does not keep. */
  abstract findMetadata(key: FileKey): Promise<FileMetadata | undefined>;

  /**
   * The owner's execution has ended at `completedAt`: from then its files age. Idempotent — a
   * second call (a recovery ending the same tree again) keeps the first moment. A file saved for
   * the owner afterwards ages from that moment too.
   */
  abstract markOwnerCompleted(completion: FileOwnerCompletion): Promise<void>;

  /**
   * The sweep: removes the files of the owners that have ended and whose time is up
   * (see `FileSweep`), and the owner's mark with its last file; gives the number of files
   * removed (`onTtlSweep`'s count). The files of an owner not marked completed — a running or a
   * paused execution — are never removed, whatever their age. Never scans an owner whose time is not up.
   */
  abstract deleteExpired(sweep: FileSweep): Promise<number>;

  /** Removes every file of one owner. */
  abstract deleteByOwner(owner: FileOwner): Promise<void>;
}

/**
 * The built-in default (#859): no store — a file's bytes ride inline in its descriptor, so in the
 * task's own records. The framework never saves into it; a call is a wiring bug.
 */
@Injectable()
export class InlineFileRepository extends FileRepository {
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

  findMetadata(): Promise<FileMetadata | undefined> {
    return Promise.resolve(undefined);
  }

  markOwnerCompleted(): Promise<void> {
    return Promise.resolve();
  }

  deleteExpired(): Promise<number> {
    return Promise.resolve(0);
  }

  deleteByOwner(): Promise<void> {
    return Promise.resolve();
  }
}

/** Whether a store keeps no file: the default, whose files ride inline. */
export const isInlineFileStore = (store: FileRepository): boolean =>
  store instanceof InlineFileRepository;

/** Whether two saves of one key are the same file. */
export const isSameFile = (kept: FileMetadata, saved: FileMetadata): boolean =>
  kept.sha256 === saved.sha256 && kept.sizeBytes === saved.sizeBytes;

/** A file's metadata without its bytes, as a store answers it. */
export const metadataOf = (file: FileMetadata): FileMetadata => ({
  tenantId: file.tenantId,
  fileId: file.fileId,
  ownerId: file.ownerId,
  mediaType: file.mediaType,
  ...(file.filename === undefined ? {} : { filename: file.filename }),
  sha256: file.sha256,
  sizeBytes: file.sizeBytes,
  createdAt: new Date(file.createdAt.getTime()),
  ...(file.ttl === undefined ? {} : { ttl: file.ttl }),
});

/** Whether a file is up at the sweep: its own `ttl`, else its workflow's cutoff, from `completedAt`. */
export function isFileExpired(
  file: Pick<FileMetadata, "ttl">,
  completion: Pick<FileOwnerCompletion, "workflow" | "completedAt">,
  sweep: FileSweep,
): boolean {
  const completed = completion.completedAt.getTime();
  const cutoff = sweep.cutoffsByWorkflow.get(completion.workflow);
  if (cutoff !== undefined && completed < cutoff.getTime()) return true;
  return file.ttl !== undefined && completed + file.ttl < sweep.now.getTime();
}
