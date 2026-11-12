import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Injectable } from "../components/decorators.js";
import { EnvironmentField } from "../environments/contract.js";
import { ApplicationContext } from "../flow/context/application-context.js";
import {
  A2AFileConflictError,
  A2AFileRepository,
  isSameFile,
  ownerPageOf,
  metadataOf,
  type A2AFileKey,
  type A2AFileMetadata,
  type A2AFileOwner,
  type NewA2AFile,
} from "./a2a-file.repository.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";

/** A name of a folder or a file for any text: its SHA-256, so no id reaches a path. */
const nameOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A file's metadata as kept on disk: JSON, its time as ISO 8601. */
type StoredMetadata = Omit<A2AFileMetadata, "createdAt"> & { readonly createdAt: string };

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
const isTaken = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "code") === "EEXIST";

const parsedOf = (text: string): A2AFileMetadata => {
  const stored = JSON.parse(text) as StoredMetadata;
  return metadataOf({ ...stored, createdAt: new Date(stored.createdAt) });
};

/**
 * The files in a folder of one host (#859, `a2aFilesPath` of the environment): a folder per tenant,
 * two files per file — its bytes, then its metadata, each written whole under a temporary name and
 * linked into place (a link never replaces: of two saves of one id one is kept, the other compared
 * with it). A file is there once its metadata is. Single-host: `[a2a.file-store-not-shared]` when
 * leases are shared and files are large.
 */
@Injectable({
  deps: [ApplicationContext],
  environmentFields: { a2aFilesPath: EnvironmentField.text() },
})
export class LocalDiskA2AFileRepository extends A2AFileRepository {
  static override readonly store: StoreDescriptor = { backend: "local-disk" };

  /** The folder the files are kept in. */
  readonly folder: string;

  constructor(applicationContext: ApplicationContext) {
    super();
    const folder: unknown = Reflect.get(applicationContext.environment, "a2aFilesPath");
    if (typeof folder !== "string" || folder === "")
      throw new Error(
        "LocalDiskA2AFileRepository needs a2aFilesPath: string in the environment — the folder the files are kept in",
      );
    this.folder = folder;
  }

  async ping(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    await stat(this.folder);
  }

  async save(file: NewA2AFile): Promise<void> {
    const kept = await this.findMetadata(file);
    if (kept !== undefined) {
      if (!isSameFile(kept, file)) throw new A2AFileConflictError({ fileId: file.fileId });
      return;
    }
    const tenant = join(this.folder, nameOf(file.tenantId));
    await mkdir(tenant, { recursive: true });
    const base = join(tenant, nameOf(file.fileId));
    const stored: StoredMetadata = { ...metadataOf(file), createdAt: file.createdAt.toISOString() };
    // the bytes under their own digest: a save that lost never reads as another's
    await this.#placed(`${base}.${file.sha256}.bin`, file.bytes);
    if (!(await this.#placed(`${base}.json`, JSON.stringify(stored)))) {
      const other = await this.findMetadata(file);
      if (other !== undefined && !isSameFile(other, file))
        throw new A2AFileConflictError({ fileId: file.fileId });
    }
  }

  async findBytes(key: A2AFileKey): Promise<Uint8Array | undefined> {
    const found = await this.findMetadata(key);
    if (found === undefined) return undefined;
    return this.#read(`${this.#baseOf(key)}.${found.sha256}.bin`);
  }

  async findMetadata(key: A2AFileKey): Promise<A2AFileMetadata | undefined> {
    const text = await this.#read(`${this.#baseOf(key)}.json`);
    if (text === undefined) return undefined;
    const found = parsedOf(Buffer.from(text).toString("utf8"));
    return found.tenantId === key.tenantId && found.fileId === key.fileId ? found : undefined;
  }

  async findOwnersByCreatedAtBefore(
    cutoff: Date,
    limit: number,
    after?: A2AFileOwner,
  ): Promise<readonly A2AFileOwner[]> {
    const found = (await this.#all()).filter((file) => file.createdAt.getTime() < cutoff.getTime());
    return ownerPageOf(found, limit, after);
  }

  async deleteByOwner(owner: A2AFileOwner): Promise<void> {
    const tenant = join(this.folder, nameOf(owner.tenantId));
    for (const file of await this.#all()) {
      if (file.tenantId !== owner.tenantId || file.ownerId !== owner.ownerId) continue;
      const base = nameOf(file.fileId);
      // the metadata first: a file is gone once it is; then every bytes file of its id
      await rm(join(tenant, `${base}.json`), { force: true });
      for (const name of await this.#names(tenant))
        if (name.startsWith(`${base}.`)) await rm(join(tenant, name), { force: true });
    }
  }

  #baseOf(key: A2AFileKey): string {
    return join(this.folder, nameOf(key.tenantId), nameOf(key.fileId));
  }

  /** Writes `content` at `path` unless a file is there: `false` when one was. */
  async #placed(path: string, content: Uint8Array | string): Promise<boolean> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { flag: "wx" });
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (isTaken(error)) return false;
      throw error;
    } finally {
      await unlink(temporary);
    }
  }

  async #read(path: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** Every file's metadata, every tenant's. */
  async #all(): Promise<readonly A2AFileMetadata[]> {
    const tenants = await this.#names(this.folder);
    const found: A2AFileMetadata[] = [];
    for (const tenant of tenants) {
      for (const name of await this.#names(join(this.folder, tenant))) {
        if (!name.endsWith(".json")) continue;
        const text = await this.#read(join(this.folder, tenant, name));
        if (text !== undefined) found.push(parsedOf(Buffer.from(text).toString("utf8")));
      }
    }
    return found;
  }

  async #names(folder: string): Promise<readonly string[]> {
    try {
      return await readdir(folder);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}
