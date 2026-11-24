import { fileConflict } from "../../files/file-errors.js";
import { Injectable } from "../../components/decorators.js";
import { OBJECT_SETTINGS, type ResolvedSettings } from "../../storage/settings.js";
import { EnvironmentField } from "../../environments/contract.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import {
  FileRepository,
  isSameFile,
  metadataOf,
  type FileKey,
  type FileMetadata,
  type FileOwner,
  type FileOwnerCompletion,
  type FileSweep,
  type NewFile,
} from "../file.repository.js";
import { Clock } from "../clock.js";
import type { StoreDescriptor } from "../execution-lease.repository.js";
import { S3Client } from "./s3-client.js";
import { locationOf } from "./s3-file-location.js";
import {
  completedFolderOf,
  completedKeyOf,
  completionBodyOf,
  completionMarkKeyOf,
  completionOfBody,
  entryBodyOf,
  expiresKeyOf,
  expiryBodyOf,
  expiryOfBody,
  isoOfKey,
  fileBytesOf,
  fileKeyOf,
  indexEntryOf,
  indexKeyOf,
  objectBodyOf,
  ownerFolderOf,
  segmentOf,
  storedMetadataOf,
  type StoredMetadata,
} from "./s3-file-layout.js";

/** How much of a file's object is read for its metadata: past it, the whole object. */
const METADATA_READ = 16 * 1024;

/**
 * The files in an S3 bucket (#859): one object per file — its metadata, then its bytes
 * (`s3-a2a-file-layout.ts`) — written only when absent (`If-None-Match: *`, so of two saves one is kept and the other
 * compared with it), and one empty object per file in its owner's index,
 * `owners/<tenant>/<owner>/<saved at>/<file>` (its body the owner), what the sweep lists — every
 * key within S3's limits for every valid id (#904). Every instance reaches the
 * bucket: the store for files above 256 KB on shared leases. Pure `fetch` and Signature Version 4;
 * an S3-compatible store on `a2aS3Endpoint`. The bucket's own lifecycle rules are a safety net, never
 * the retention.
 */
@Injectable({
  deps: [ApplicationContext, Clock, OBJECT_SETTINGS],
  environmentFields: {
    a2aS3Bucket: EnvironmentField.text(),
    a2aS3Region: EnvironmentField.text(),
    a2aS3Endpoint: EnvironmentField.text({ optional: true }),
    a2aS3Prefix: EnvironmentField.text({ optional: true }),
    a2aS3AccessKeyId: EnvironmentField.secret(),
    a2aS3SecretAccessKey: EnvironmentField.secret(),
  },
})
export class S3FileRepository extends FileRepository {
  static override readonly store: StoreDescriptor = { backend: "s3" };

  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(
    applicationContext: ApplicationContext,
    clock: Clock,
    settings: ResolvedSettings | undefined,
    fetcher: typeof fetch = fetch,
  ) {
    super();
    const location = locationOf(applicationContext, settings);
    this.#client = new S3Client(location, clock, fetcher);
    this.#prefix = location.prefix;
  }

  ping(): Promise<void> {
    return this.#client.ping();
  }

  async save(file: NewFile): Promise<void> {
    const stored: StoredMetadata = { ...metadataOf(file), createdAt: file.createdAt.toISOString() };
    const body = objectBodyOf(stored, file.bytes);
    const isNew = await this.#client.putIfAbsent(this.#fileKey(file), body, {});
    if (!isNew) {
      const kept = await this.findMetadata(file);
      if (kept !== undefined && !isSameFile(kept, file))
        throw fileConflict({ fileId: file.fileId });
    }
    // the index after the file: a file the sweep finds is there; one written twice is one key
    const entry = `${this.#prefix}${indexKeyOf(file)}`;
    await this.#client.putIfAbsent(entry, entryBodyOf(file), {});
  }

  async findBytes(key: FileKey): Promise<Uint8Array | undefined> {
    const body = await this.#client.get(this.#fileKey(key));
    return body === undefined ? undefined : fileBytesOf(body);
  }

  async findMetadata(key: FileKey): Promise<FileMetadata | undefined> {
    const stored = await this.#storedAt(this.#fileKey(key));
    if (stored === undefined) return undefined;
    return metadataOf({ ...stored, createdAt: new Date(stored.createdAt) });
  }

  async markOwnerCompleted(completion: FileOwnerCompletion): Promise<void> {
    const mark = `${this.#prefix}${completionMarkKeyOf(completion)}`;
    const isNew = await this.#client.putIfAbsent(mark, completionBodyOf(completion), {});
    // a call again after a crash in the middle goes on from the first moment, never a later one
    const first = isNew ? undefined : await this.#client.get(mark);
    const at = first === undefined ? completion : completionOfBody(first);
    await this.#client.putIfAbsent(
      `${this.#prefix}${completedKeyOf(at)}`,
      completionBodyOf(at),
      {},
    );
    // a file with a time of its own is up before its workflow's: indexed by when
    for await (const key of this.#client.keys(`${this.#prefix}${ownerFolderOf(completion)}`)) {
      const entry = indexEntryOf(key.slice(this.#prefix.length));
      if (entry === undefined) continue;
      const stored = await this.#storedAt(`${this.#prefix}${fileKeyOf(entry.tenant, entry.file)}`);
      if (stored?.ttl === undefined) continue;
      const expiresAt = new Date(at.completedAt.getTime() + stored.ttl);
      await this.#client.putIfAbsent(
        `${this.#prefix}${expiresKeyOf(expiresAt, completion, stored.fileId)}`,
        expiryBodyOf(at, stored.fileId),
        {},
      );
    }
  }

  async deleteExpired(sweep: FileSweep): Promise<number> {
    let removed = 0;
    for (const [workflow, cutoff] of sweep.cutoffsByWorkflow)
      removed += await this.#sweptWorkflow(workflow, cutoff);
    return removed + (await this.#sweptExpiries(sweep.now));
  }

  /** The owners of one workflow that completed before its cutoff: the index is read to there only. */
  async #sweptWorkflow(workflow: string, cutoff: Date): Promise<number> {
    let removed = 0;
    const until = cutoff.toISOString();
    const folder = `${this.#prefix}${completedFolderOf(workflow)}`;
    for await (const key of this.#client.keys(folder)) {
      const at = isoOfKey(key.slice(folder.length));
      // the keys sort by the time: the first not up ends the look
      if (at === undefined || at >= until) break;
      const body = await this.#client.get(key);
      if (body !== undefined) removed += await this.#removedOwner(completionOfBody(body));
    }
    return removed;
  }

  /** The files with a ttl of their own that are up at `now`: the index is read to there only. */
  async #sweptExpiries(now: Date): Promise<number> {
    let removed = 0;
    const until = now.toISOString();
    const expires = `${this.#prefix}expires/`;
    for await (const key of this.#client.keys(expires)) {
      const at = isoOfKey(key.slice(expires.length));
      if (at === undefined || at >= until) break;
      const body = await this.#client.get(key);
      if (body === undefined) continue;
      const { completion, fileId } = expiryOfBody(body);
      if (await this.#removedFile(completion, fileId)) removed += 1;
      await this.#client.delete(key);
      await this.#endedIfEmpty(completion);
    }
    return removed;
  }

  async deleteByOwner(owner: FileOwner): Promise<void> {
    await this.#removedOwner({ ...owner, workflow: "", completedAt: new Date(0) }, false);
    await this.#client.delete(`${this.#prefix}${completionMarkKeyOf(owner)}`);
  }

  /**
   * Every file of an owner removed, each its object first and its index entry after: a sweep cut
   * short finds it again. The owner's completion goes with them; the number of files that were there.
   */
  async #removedOwner(completion: FileOwnerCompletion, isCompletion = true): Promise<number> {
    let removed = 0;
    for await (const key of this.#client.keys(`${this.#prefix}${ownerFolderOf(completion)}`)) {
      const entry = indexEntryOf(key.slice(this.#prefix.length));
      if (entry === undefined) continue;
      const object = `${this.#prefix}${fileKeyOf(entry.tenant, entry.file)}`;
      if ((await this.#client.get(object, 1)) !== undefined) removed += 1;
      await this.#client.delete(object);
      await this.#client.delete(key);
    }
    if (isCompletion) await this.#endCompletion(completion);
    return removed;
  }

  /** One file of an owner removed; whether it was there. */
  async #removedFile(owner: FileOwner, fileId: string): Promise<boolean> {
    const object = `${this.#prefix}${fileKeyOf(segmentOf(owner.tenantId), segmentOf(fileId))}`;
    const stored = await this.#storedAt(object);
    if (stored === undefined) return false;
    await this.#client.delete(object);
    await this.#client.delete(
      `${this.#prefix}${indexKeyOf(metadataOf({ ...stored, createdAt: new Date(stored.createdAt) }))}`,
    );
    return true;
  }

  /** The owner's completion ended when it has no file left: its mark and its index entry go. */
  async #endedIfEmpty(completion: FileOwnerCompletion): Promise<void> {
    for await (const key of this.#client.keys(`${this.#prefix}${ownerFolderOf(completion)}`))
      if (indexEntryOf(key.slice(this.#prefix.length)) !== undefined) return;
    await this.#endCompletion(completion);
  }

  async #endCompletion(completion: FileOwnerCompletion): Promise<void> {
    await this.#client.delete(`${this.#prefix}${completedKeyOf(completion)}`);
    await this.#client.delete(`${this.#prefix}${completionMarkKeyOf(completion)}`);
  }

  /** A file's stored metadata at an object's key: the start of its body, else the whole one. */
  async #storedAt(object: string): Promise<StoredMetadata | undefined> {
    const head = await this.#client.get(object, METADATA_READ);
    if (head === undefined) return undefined;
    // a metadata longer than the read (a very long filename): the whole object
    return storedMetadataOf(head) ?? storedMetadataOf((await this.#client.get(object)) ?? head);
  }

  #fileKey(key: FileKey): string {
    return `${this.#prefix}${fileKeyOf(segmentOf(key.tenantId), segmentOf(key.fileId))}`;
  }
}
