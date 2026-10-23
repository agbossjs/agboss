import { Injectable } from "../components/decorators.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
import type { InMemoryDatabase } from "./in-memory-database.js";

/**
 * Infrastructure (#398 PR 2, Q8): the answers of trusted mesh requests by their idempotency key —
 * scoped by the receiver's tenant and the authenticated peer (a key guessed by another caller finds
 * nothing). A request whose key is already here gets the same answer without running again, or —
 * while the first runs — a refusal (`mesh.request-in-progress`). Kept `@Application({ mesh: {
 * idempotencyRetention } })` (default `minutes(30)`), then removed by the recovery sweep on the
 * `Clock`. Listed only in `@Application({ providers })`; the built-in default is in memory, and
 * `SqliteMeshRequestRepository` shares the answers between instances on one file.
 */

/** The key of a request: the receiver's tenant, the peer and the caller's idempotency key. */
export interface MeshRequestKey {
  readonly tenantId: string;
  readonly peer: string;
  readonly idempotencyKey: string;
}

/** One request as kept: when it came, and its answer once it has one (plain JSON). */
export interface MeshRequestRecord extends MeshRequestKey {
  /** When the receiver admitted it (ISO 8601, the `Clock`). */
  readonly createdAt: string;
  /** The answer sent (the `A2AExecutionResponse`); `undefined` while it runs. */
  readonly response?: unknown;
}

export abstract class MeshRequestRepository {
  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /** Saves a request that is not kept yet; `true` when this call saved it (atomic). */
  abstract saveIfAbsent(record: MeshRequestRecord): Promise<boolean>;

  /** The request of `key`; `undefined` when none is kept. */
  abstract findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined>;

  /** Keeps the answer of a saved request. */
  abstract saveResponse(key: MeshRequestKey, response: unknown): Promise<void>;

  /** Forgets a request whose run did not answer (its caller may try again). */
  abstract deleteByKey(key: MeshRequestKey): Promise<void>;

  /** Removes every request admitted before `cutoff` (the recovery sweep, `now - retention`). */
  abstract deleteCreatedBefore(cutoff: Date): Promise<void>;
}

/** The row key of a request (`\u0000` never occurs in a name or a key). */
export const meshRequestKeyOf = (key: MeshRequestKey): string =>
  `${key.tenantId}\u0000${key.peer}\u0000${key.idempotencyKey}`;

/** The built-in default: the requests in this instance's memory, a copy of each answer. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class InMemoryMeshRequestRepository extends MeshRequestRepository {
  constructor(private readonly database: InMemoryDatabase) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    const key = meshRequestKeyOf(record);
    if (this.database.meshRequests.has(key)) return Promise.resolve(false);
    this.database.meshRequests.set(key, structuredClone(record));
    return Promise.resolve(true);
  }

  findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined> {
    const record = this.database.meshRequests.get(meshRequestKeyOf(key));
    return Promise.resolve(record === undefined ? undefined : structuredClone(record));
  }

  saveResponse(key: MeshRequestKey, response: unknown): Promise<void> {
    const row = meshRequestKeyOf(key);
    const record = this.database.meshRequests.get(row);
    if (record !== undefined)
      this.database.meshRequests.set(row, { ...record, response: structuredClone(response) });
    return Promise.resolve();
  }

  deleteByKey(key: MeshRequestKey): Promise<void> {
    this.database.meshRequests.delete(meshRequestKeyOf(key));
    return Promise.resolve();
  }

  deleteCreatedBefore(cutoff: Date): Promise<void> {
    for (const [row, record] of this.database.meshRequests)
      if (Date.parse(record.createdAt) < cutoff.getTime()) this.database.meshRequests.delete(row);
    return Promise.resolve();
  }
}
