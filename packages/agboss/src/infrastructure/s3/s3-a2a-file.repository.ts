import { Injectable } from "../../components/decorators.js";
import { EnvironmentField } from "../../environments/contract.js";
import { Secret } from "../../environments/secret.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import {
  A2AFileConflictError,
  A2AFileRepository,
  isSameFile,
  checkedPageLimit,
  ownerOrderOf,
  metadataOf,
  type A2AFileKey,
  type A2AFileMetadata,
  type A2AFileOwner,
  type NewA2AFile,
} from "../a2a-file.repository.js";
import { Clock } from "../clock.js";
import type { StoreDescriptor } from "../execution-lease.repository.js";
import { S3Client, type S3Location } from "./s3-client.js";
import {
  entryBodyOf,
  fileBytesOf,
  fileKeyOf,
  indexEntryOf,
  indexKeyOf,
  objectBodyOf,
  ownerFolderOf,
  ownerOfEntryBody,
  prefixProblemOf,
  segmentOf,
  storedMetadataOf,
  textOf,
  type IndexEntry,
  type StoredMetadata,
} from "./s3-a2a-file-layout.js";

/** How much of a file's object is read for its metadata: past it, the whole object. */
const METADATA_READ = 16 * 1024;

/** What the store reads from the environment. */
function locationOf(context: ApplicationContext): S3Location & { readonly prefix: string } {
  const text = (name: string): string | undefined => {
    const value: unknown = Reflect.get(context.environment, name);
    if (value instanceof Secret) return value.reveal();
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const required = (name: string): string => {
    const value = text(name);
    if (value === undefined)
      throw new Error(`S3A2AFileRepository needs ${name} in the environment`);
    return value;
  };
  return {
    bucket: required("a2aS3Bucket"),
    region: required("a2aS3Region"),
    endpoint: text("a2aS3Endpoint"),
    credentials: {
      accessKeyId: required("a2aS3AccessKeyId"),
      secretAccessKey: required("a2aS3SecretAccessKey"),
    },
    prefix: checkedPrefix(text("a2aS3Prefix") ?? "agboss-a2a-files/"),
  };
}

/** The prefix, if it leaves room for every key (#904). */
function checkedPrefix(prefix: string): string {
  const problem = prefixProblemOf(prefix);
  if (problem !== undefined) throw new Error(`S3A2AFileRepository: ${problem}`);
  return prefix;
}

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
  deps: [ApplicationContext, Clock],
  environmentFields: {
    a2aS3Bucket: EnvironmentField.text(),
    a2aS3Region: EnvironmentField.text(),
    a2aS3Endpoint: EnvironmentField.text({ optional: true }),
    a2aS3Prefix: EnvironmentField.text({ optional: true }),
    a2aS3AccessKeyId: EnvironmentField.secret(),
    a2aS3SecretAccessKey: EnvironmentField.secret(),
  },
})
export class S3A2AFileRepository extends A2AFileRepository {
  static override readonly store: StoreDescriptor = { backend: "s3" };

  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(applicationContext: ApplicationContext, clock: Clock, fetcher: typeof fetch = fetch) {
    super();
    const location = locationOf(applicationContext);
    this.#client = new S3Client(location, clock, fetcher);
    this.#prefix = location.prefix;
  }

  ping(): Promise<void> {
    return this.#client.ping();
  }

  async save(file: NewA2AFile): Promise<void> {
    const stored: StoredMetadata = { ...metadataOf(file), createdAt: file.createdAt.toISOString() };
    const body = objectBodyOf(stored, file.bytes);
    const isNew = await this.#client.putIfAbsent(this.#fileKey(file), body, {});
    if (!isNew) {
      const kept = await this.findMetadata(file);
      if (kept !== undefined && !isSameFile(kept, file))
        throw new A2AFileConflictError({ fileId: file.fileId });
    }
    // the index after the file: a file the sweep finds is there; one written twice is one key
    const entry = `${this.#prefix}${indexKeyOf(file)}`;
    await this.#client.putIfAbsent(entry, entryBodyOf(file), {});
  }

  async findBytes(key: A2AFileKey): Promise<Uint8Array | undefined> {
    const body = await this.#client.get(this.#fileKey(key));
    return body === undefined ? undefined : fileBytesOf(body);
  }

  async findMetadata(key: A2AFileKey): Promise<A2AFileMetadata | undefined> {
    const fileKey = this.#fileKey(key);
    const head = await this.#client.get(fileKey, METADATA_READ);
    if (head === undefined) return undefined;
    // a metadata longer than the read (a very long filename): the whole object
    const stored =
      storedMetadataOf(head) ?? storedMetadataOf((await this.#client.get(fileKey)) ?? head);
    if (stored === undefined) return undefined;
    return metadataOf({ ...stored, createdAt: new Date(stored.createdAt) });
  }

  /**
   * The owners in the index's key order: listed from `StartAfter` past `after`'s own keys, stopped
   * at the `limit`-th owner with a file saved before `cutoff` — never the whole bucket for a page.
   * An owner named by a digest is read from its entry's body.
   */
  async findOwnersByCreatedAtBefore(
    cutoff: Date,
    limit: number,
    after?: A2AFileOwner,
  ): Promise<readonly A2AFileOwner[]> {
    checkedPageLimit(limit);
    const index = `${this.#prefix}owners/`;
    // `~` sorts after the digits of every saved time: past every key of `after`, before the next owner's
    const startAfter = after === undefined ? undefined : `${this.#prefix}${ownerFolderOf(after)}~`;
    const found = new Map<string, A2AFileOwner>();
    for await (const key of this.#client.keys(index, startAfter)) {
      const entry = indexEntryOf(key.slice(this.#prefix.length));
      if (entry === undefined || entry.savedAt >= cutoff.getTime()) continue;
      const owner = await this.#ownerOf(key, entry);
      if (owner === undefined) continue;
      found.set(ownerOrderOf(owner), owner);
      if (found.size >= limit) break;
    }
    return [...found.values()];
  }

  async deleteByOwner(owner: A2AFileOwner): Promise<void> {
    for await (const key of this.#client.keys(`${this.#prefix}${ownerFolderOf(owner)}`)) {
      const entry = indexEntryOf(key.slice(this.#prefix.length));
      if (entry === undefined) continue;
      // the file first, its index entry after: a sweep cut short finds it again
      await this.#client.delete(`${this.#prefix}${fileKeyOf(entry.tenant, entry.file)}`);
      await this.#client.delete(key);
    }
  }

  #fileKey(key: A2AFileKey): string {
    return `${this.#prefix}${fileKeyOf(segmentOf(key.tenantId), segmentOf(key.fileId))}`;
  }

  /** The owner of an index entry: from its key, else (a digest) from its body. */
  async #ownerOf(key: string, entry: IndexEntry): Promise<A2AFileOwner | undefined> {
    const tenantId = textOf(entry.tenant);
    const ownerId = textOf(entry.owner);
    if (tenantId !== undefined && ownerId !== undefined) return { tenantId, ownerId };
    const body = await this.#client.get(key);
    // gone between the listing and the read: removed with its owner
    return body === undefined ? undefined : ownerOfEntryBody(body);
  }
}
