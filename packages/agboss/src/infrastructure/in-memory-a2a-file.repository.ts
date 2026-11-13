import { Injectable } from "../components/decorators.js";
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
import { IN_MEMORY_DATABASE, type InMemoryDatabase } from "./in-memory-database.js";

const rowOf = (key: A2AFileKey): string => `${key.tenantId}\u0000${key.fileId}`;

/**
 * The files in this instance's memory (#859), a copy of each in and out: lost on restart, never seen
 * by another instance — `[a2a.file-store-not-shared]` when leases are shared and files are large.
 */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class InMemoryA2AFileRepository extends A2AFileRepository {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };

  /**
   * @internal The container injects the instance's in-memory database: left out of the declarations.
   */
  constructor(private readonly database: InMemoryDatabase) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  save(file: NewA2AFile): Promise<void> {
    const files = this.database.a2aFiles;
    const kept = files.get(rowOf(file));
    if (kept !== undefined)
      return isSameFile(kept, file)
        ? Promise.resolve()
        : Promise.reject(new A2AFileConflictError({ fileId: file.fileId }));
    files.set(rowOf(file), { ...metadataOf(file), bytes: Uint8Array.from(file.bytes) });
    return Promise.resolve();
  }

  findBytes(key: A2AFileKey): Promise<Uint8Array | undefined> {
    const kept = this.database.a2aFiles.get(rowOf(key));
    return Promise.resolve(kept === undefined ? undefined : Uint8Array.from(kept.bytes));
  }

  findMetadata(key: A2AFileKey): Promise<A2AFileMetadata | undefined> {
    const kept = this.database.a2aFiles.get(rowOf(key));
    return Promise.resolve(kept === undefined ? undefined : metadataOf(kept));
  }

  findOwnersByCreatedAtBefore(
    cutoff: Date,
    limit: number,
    after?: A2AFileOwner,
  ): Promise<readonly A2AFileOwner[]> {
    const found = [...this.database.a2aFiles.values()].filter(
      (file) => file.createdAt.getTime() < cutoff.getTime(),
    );
    // a refused limit rejects, as a store's would
    return Promise.resolve().then(() => ownerPageOf(found, limit, after));
  }

  deleteByOwner(owner: A2AFileOwner): Promise<void> {
    const files = this.database.a2aFiles;
    for (const [row, file] of files)
      if (file.tenantId === owner.tenantId && file.ownerId === owner.ownerId) files.delete(row);
    return Promise.resolve();
  }
}
