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

/** A key's segment for any text: base64url, so no id is ever a path of its own. */
const segmentOf = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
const textOf = (segment: string): string => Buffer.from(segment, "base64url").toString("utf8");

/** How a file's metadata rides its object: one user-metadata header, base64url JSON. */
const META = "agboss";

type StoredMetadata = Omit<A2AFileMetadata, "createdAt"> & { readonly createdAt: string };

/** The width of a save's time in an owner's index key: sorted as text, in time order. */
const TIME_WIDTH = 15;

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
    prefix: text("a2aS3Prefix") ?? "agboss-a2a-files/",
  };
}

/**
 * The files in an S3 bucket (#859): one object per file — its bytes, its metadata in a user-metadata
 * header — written only when absent (`If-None-Match: *`, so of two saves one is kept and the other
 * compared with it), and one empty object per file in its owner's index,
 * `owners/<tenant>/<owner>/<saved at>.<file>`, what the sweep lists. Every instance reaches the
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
    const meta = { [META]: Buffer.from(JSON.stringify(stored)).toString("base64url") };
    const isNew = await this.#client.putIfAbsent(this.#fileKey(file), file.bytes, meta);
    if (!isNew) {
      const kept = await this.findMetadata(file);
      if (kept !== undefined && !isSameFile(kept, file))
        throw new A2AFileConflictError(file.fileId);
    }
    // the index after the file: a file the sweep finds is there; one written twice is one key
    await this.#client.putIfAbsent(this.#ownerKey(file), new Uint8Array(), {});
  }

  findBytes(key: A2AFileKey): Promise<Uint8Array | undefined> {
    return this.#client.get(this.#fileKey(key));
  }

  async findMetadata(key: A2AFileKey): Promise<A2AFileMetadata | undefined> {
    const head = await this.#client.head(this.#fileKey(key));
    const encoded = head?.metadata[META];
    if (encoded === undefined) return undefined;
    const stored = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StoredMetadata;
    return metadataOf({ ...stored, createdAt: new Date(stored.createdAt) });
  }

  /**
   * The owners in the index's key order: listed from `StartAfter` past `after`'s own keys, stopped
   * at the `limit`-th owner with a file saved before `cutoff` — never the whole bucket for a page.
   */
  async findOwnersByCreatedAtBefore(
    cutoff: Date,
    limit: number,
    after?: A2AFileOwner,
  ): Promise<readonly A2AFileOwner[]> {
    checkedPageLimit(limit);
    const index = `${this.#prefix}owners/`;
    // `~` sorts after the digits of every saved time: past every key of `after`, before the next owner's
    const startAfter = after === undefined ? undefined : `${this.#ownerIndexOf(after)}~`;
    const found = new Map<string, A2AFileOwner>();
    for await (const key of this.#client.keys(index, startAfter)) {
      const entry = this.#entryOf(key);
      if (entry === undefined || entry.savedAt >= cutoff.getTime()) continue;
      found.set(ownerOrderOf(entry), { tenantId: entry.tenantId, ownerId: entry.ownerId });
      if (found.size >= limit) break;
    }
    return [...found.values()];
  }

  async deleteByOwner(owner: A2AFileOwner): Promise<void> {
    for await (const key of this.#client.keys(this.#ownerIndexOf(owner))) {
      const entry = this.#entryOf(key);
      if (entry === undefined) continue;
      // the file first, its index entry after: a sweep cut short finds it again
      await this.#client.delete(this.#fileKey(entry));
      await this.#client.delete(key);
    }
  }

  #fileKey(key: A2AFileKey): string {
    return `${this.#prefix}files/${segmentOf(key.tenantId)}/${segmentOf(key.fileId)}`;
  }

  /** The index's folder of one owner, `…/owners/<tenant>/<owner>/`. */
  #ownerIndexOf(owner: A2AFileOwner): string {
    return `${this.#prefix}owners/${segmentOf(owner.tenantId)}/${segmentOf(owner.ownerId)}/`;
  }

  #ownerKey(file: A2AFileMetadata): string {
    const savedAt = String(file.createdAt.getTime()).padStart(TIME_WIDTH, "0");
    return `${this.#ownerIndexOf(file)}${savedAt}.${segmentOf(file.fileId)}`;
  }

  /** What an owner's index key names; `undefined` for a key of no index entry. */
  #entryOf(key: string) {
    const match = /owners\/([\w-]+)\/([\w-]+)\/(\d+)\.([\w-]+)$/.exec(
      key.slice(this.#prefix.length),
    );
    if (match === null) return undefined;
    const [, tenant = "", owner = "", savedAt = "0", file = ""] = match;
    return {
      tenantId: textOf(tenant),
      ownerId: textOf(owner),
      savedAt: Number(savedAt),
      fileId: textOf(file),
    };
  }
}
