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
  type FileOrphanSweep,
  type FileOwnerCompletion,
  type FileSweep,
  type NewFile,
} from "../file.repository.js";
import { Clock } from "../clock.js";
import type { StoreDescriptor } from "../execution-lease.repository.js";
import { S3Client } from "./s3-client.js";
import { S3FileSweeps } from "./s3-file-sweeps.js";
import { locationOf } from "./s3-file-location.js";
import {
  completionMarkKeyOf,
  entryBodyOf,
  fileBytesOf,
  fileKeyOf,
  indexKeyOf,
  objectBodyOf,
  segmentOf,
  type StoredMetadata,
} from "./s3-file-layout.js";

/** How much of a file's object is read for its metadata: past it, the whole object. */
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
  readonly #sweeps: S3FileSweeps;

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
    this.#sweeps = new S3FileSweeps(this.#client, this.#prefix);
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
    const stored = await this.#sweeps.storedAt(this.#fileKey(key));
    if (stored === undefined) return undefined;
    return metadataOf({ ...stored, createdAt: new Date(stored.createdAt) });
  }

  markOwnerCompleted(completion: FileOwnerCompletion): Promise<void> {
    return this.#sweeps.markCompleted(completion);
  }

  deleteExpired(sweep: FileSweep): Promise<number> {
    return this.#sweeps.deleteExpired(sweep);
  }

  deleteOrphans(sweep: FileOrphanSweep): Promise<number> {
    return this.#sweeps.deleteOrphans(sweep);
  }

  async deleteByOwner(owner: FileOwner): Promise<void> {
    await this.#sweeps.removedOwner({ ...owner, workflow: "", completedAt: new Date(0) }, false);
    await this.#client.delete(`${this.#prefix}${completionMarkKeyOf(owner)}`);
  }

  #fileKey(key: FileKey): string {
    return `${this.#prefix}${fileKeyOf(segmentOf(key.tenantId), segmentOf(key.fileId))}`;
  }
}
