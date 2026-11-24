import { Injectable } from "../components/decorators.js";
import { IN_MEMORY_DATABASE } from "./in-memory-database.js";
import type { InMemoryDatabase } from "./in-memory-database.js";

/**
 * Infrastructure (#398 PR 2, Q8): the answers of trusted mesh requests by their idempotency key —
 * scoped by the receiver's tenant and the authenticated peer (a key guessed by another caller finds
 * nothing). A request whose key is already here gets the same answer without running again, or —
 * while the first runs — a refusal (`mesh.request-in-progress`). Kept `@Application({ retention: {
 * meshAnswers } })` (default `minutes(30)`), then removed by the recovery sweep on the
 * `Clock`. Listed only in `@Application({ providers })`; the built-in default is in memory, and
 * `SqliteMeshRequestRepository` shares the answers between instances on one file.
 */

/** The key of a request: the receiver's tenant, the peer and the caller's idempotency key. */
export interface MeshRequestKey {
  readonly tenantId: string;
  readonly peer: string;
  readonly idempotencyKey: string;
}

/** One request as kept: what it asked, when it came and until when it is kept, and its answer once it has one (plain JSON). */
export interface MeshRequestRecord extends MeshRequestKey {
  /** The tool the request called: a repeat of the key naming another one is a different request. */
  readonly tool: string;
  /** `sha256:<hex>` of the request's tool and arguments: a repeat of the key with other arguments is a different request. */
  readonly requestHash: string;
  /** When the receiver admitted it (ISO 8601, the `Clock`). */
  readonly createdAt: string;
  /** Until when its answer is kept (ISO 8601): `createdAt` + `@Mesh({ deduplicationTtl })`. */
  readonly expiresAt: string;
  /** The answer sent (the MCP result, #398); `undefined` while it runs. */
  readonly response?: unknown;
}

/**
 * How long past its `expiresAt` a request with no answer keeps its row (1 hour): its replay window
 * has passed by then, so a handler that crashed no longer locks its key out for good, and the table
 * does not grow. Inside the window the row stays, so a replay is refused.
 */
export const MESH_IN_PROGRESS_GRACE_MS = 60 * 60_000;

export abstract class MeshRequestRepository {
  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * Saves a request that is not kept yet, with its `response` when the record has one (a marker
   * that is finished at once); `true` when this call saved it (atomic).
   */
  abstract saveIfAbsent(record: MeshRequestRecord): Promise<boolean>;

  /** The request of `key`; `undefined` when none is kept. */
  abstract findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined>;

  /** Keeps the answer of a saved request. */
  abstract saveResponse(key: MeshRequestKey, response: unknown): Promise<void>;

  /** Forgets a request whose run did not answer (its caller may try again). */
  abstract deleteByKey(key: MeshRequestKey): Promise<void>;

  /**
   * Removes every request whose `expiresAt` is at or before `now` and that has its answer, and every
   * one without an answer whose `expiresAt` is `MESH_IN_PROGRESS_GRACE_MS` or more past (the recovery
   * sweep), and gives the number removed (`onTtlSweep`'s count). A request still running inside its
   * window keeps its row, so a repeat of its key meets `mesh.request-in-progress`, never a second
   * run; one whose handler crashed frees its key once the window and the grace have passed.
   */
  abstract deleteExpired(now: Date): Promise<number>;
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
    // structuredClone(undefined) is undefined: a key that is not kept finds nothing
    return Promise.resolve(structuredClone(record));
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

  deleteExpired(now: Date): Promise<number> {
    let removed = 0;
    for (const [row, record] of this.database.meshRequests)
      if (
        Date.parse(record.expiresAt) <=
        now.getTime() - (record.response === undefined ? MESH_IN_PROGRESS_GRACE_MS : 0)
      ) {
        this.database.meshRequests.delete(row);
        removed += 1;
      }
    return Promise.resolve(removed);
  }
}
