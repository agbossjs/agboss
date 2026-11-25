import {
  type FileOrphanSweep,
  type FileOwner,
  type FileOwnerCompletion,
  type FileSweep,
  metadataOf,
} from "../file.repository.js";
import type { S3Client } from "./s3-client.js";
import {
  completedFolderOf,
  completedKeyOf,
  completionBodyOf,
  completionMarkKeyOf,
  completionOfBody,
  expiresKeyOf,
  expiryBodyOf,
  expiryOfBody,
  fileKeyOf,
  indexEntryOf,
  indexKeyOf,
  isoOfKey,
  ownerFolderOf,
  ownerOfEntryBody,
  segmentOf,
  storedMetadataOf,
  textOf,
  type IndexEntry,
  type StoredMetadata,
} from "./s3-file-layout.js";

/** How much of a file's object is read for its metadata: past it, the whole object. */
const METADATA_READ = 16 * 1024;

/**
 * What `S3FileRepository` does with the completion indexes (#1316): `completed/<workflow>/<time>/…`
 * and `expires/<time>/…` for the ttl sweep, the owners' index for orphans — each read only as far as
 * its time is up.
 */
export class S3FileSweeps {
  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(client: S3Client, prefix: string) {
    this.#client = client;
    this.#prefix = prefix;
  }

  async markCompleted(completion: FileOwnerCompletion): Promise<void> {
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
      const stored = await this.storedAt(`${this.#prefix}${fileKeyOf(entry.tenant, entry.file)}`);
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
      if (body !== undefined) removed += await this.removedOwner(completionOfBody(body));
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

  /**
   * The index is read whole (its keys sort by owner, not by time), an owner at a time: the newest
   * file of an owner decides, an owner with a completion mark is the sweep's by ttl, never this one's.
   */
  async deleteOrphans(sweep: FileOrphanSweep): Promise<number> {
    let removed = 0;
    let current: { key: string; entry: IndexEntry; newest: number } | undefined;
    const settle = async (): Promise<void> => {
      if (current === undefined) return;
      const { key, entry, newest } = current;
      current = undefined;
      if (newest >= sweep.createdBefore.getTime()) return;
      const owner = await this.#ownerOf(key, entry);
      if (owner === undefined) return;
      const mark = `${this.#prefix}${completionMarkKeyOf(owner)}`;
      if ((await this.#client.get(mark, 1)) !== undefined) return;
      if (await sweep.isLive(owner)) return;
      removed += await this.removedOwner(
        { ...owner, workflow: "", completedAt: new Date(0) },
        false,
      );
    };
    for await (const key of this.#client.keys(`${this.#prefix}owners/`)) {
      const entry = indexEntryOf(key.slice(this.#prefix.length));
      if (entry === undefined) continue;
      if (current?.entry.tenant !== entry.tenant || current.entry.owner !== entry.owner) {
        await settle();
        current = { key, entry, newest: 0 };
      }
      current.newest = Math.max(current.newest, entry.savedAt);
    }
    await settle();
    return removed;
  }

  /** The owner of an index entry: from its key, else (a digest) from its body. */
  async #ownerOf(key: string, entry: IndexEntry): Promise<FileOwner | undefined> {
    const tenantId = textOf(entry.tenant);
    const ownerId = textOf(entry.owner);
    if (tenantId !== undefined && ownerId !== undefined) return { tenantId, ownerId };
    const body = await this.#client.get(key);
    return body === undefined ? undefined : ownerOfEntryBody(body);
  }

  /**
   * Every file of an owner removed, each its object first and its index entry after: a sweep cut
   * short finds it again. The owner's completion goes with them; the number of files that were there.
   */
  async removedOwner(completion: FileOwnerCompletion, isCompletion = true): Promise<number> {
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
    const stored = await this.storedAt(object);
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
  async storedAt(object: string): Promise<StoredMetadata | undefined> {
    const head = await this.#client.get(object, METADATA_READ);
    if (head === undefined) return undefined;
    // a metadata longer than the read (a very long filename): the whole object
    return storedMetadataOf(head) ?? storedMetadataOf((await this.#client.get(object)) ?? head);
  }
}
