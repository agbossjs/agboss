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
  /** The attempt that owns the request while it runs: only it may answer, renew or forget it. */
  readonly attemptId: string;
  /** Until when that attempt holds the request (ISO 8601): the running handler renews it. */
  readonly lockedUntil: string;
  /** The answer sent (the MCP result, #398); `undefined` while it runs. */
  readonly response?: unknown;
}

/** How long an attempt holds a running request without renewing it (30 s): the handler renews every third of it. */
export const MESH_REQUEST_LEASE_MS = 30_000;

export abstract class MeshRequestRepository {
  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * Claims a request for `record.attemptId`; `true` when this call owns it (atomic). A key not kept
   * yet is saved, with its `response` when the record has one (a marker that is finished at once).
   * A key kept without an answer whose lease lapsed (`lockedUntil` at or before `record.createdAt`)
   * is taken over — only by the same tool and request hash; a live lease, an answered request or
   * another request under the key gives `false`.
   */
  abstract saveIfAbsent(record: MeshRequestRecord): Promise<boolean>;

  /** The request of `key`; `undefined` when none is kept. */
  abstract findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined>;

  /** Extends the lease of the attempt that holds `key`; `false` (fenced) when another attempt holds it or it is gone. */
  abstract renewLease(
    key: MeshRequestKey,
    attemptId: string,
    lockedUntil: string,
  ): Promise<boolean>;

  /** Keeps the answer of the request `attemptId` holds; `false` (fenced, nothing written) when another attempt holds it, it is answered or gone. */
  abstract saveResponse(
    key: MeshRequestKey,
    attemptId: string,
    response: unknown,
  ): Promise<boolean>;

  /** Forgets a request whose run did not answer, if `attemptId` still holds it; `false` (fenced) when another does. */
  abstract deleteByKey(key: MeshRequestKey, attemptId: string): Promise<boolean>;

  /**
   * Removes every request whose `expiresAt` is at or before `now` and that is answered or whose
   * lease has lapsed (`lockedUntil` at or before `now`), and gives the number removed (`onTtlSweep`'s
   * count). A running request whose handler keeps renewing is never removed.
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
    const kept = this.database.meshRequests.get(key);
    if (kept === undefined) {
      this.database.meshRequests.set(key, structuredClone(record));
      return Promise.resolve(true);
    }
    const canTakeOver =
      kept.response === undefined &&
      Date.parse(kept.lockedUntil) <= Date.parse(record.createdAt) &&
      kept.tool === record.tool &&
      kept.requestHash === record.requestHash;
    if (!canTakeOver) return Promise.resolve(false);
    this.database.meshRequests.set(key, {
      ...kept,
      attemptId: record.attemptId,
      createdAt: record.createdAt,
      lockedUntil: record.lockedUntil,
    });
    return Promise.resolve(true);
  }

  findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined> {
    const record = this.database.meshRequests.get(meshRequestKeyOf(key));
    // structuredClone(undefined) is undefined: a key that is not kept finds nothing
    return Promise.resolve(structuredClone(record));
  }

  renewLease(key: MeshRequestKey, attemptId: string, lockedUntil: string): Promise<boolean> {
    const row = meshRequestKeyOf(key);
    const record = this.database.meshRequests.get(row);
    if (record?.attemptId !== attemptId || record.response !== undefined)
      return Promise.resolve(false);
    this.database.meshRequests.set(row, { ...record, lockedUntil });
    return Promise.resolve(true);
  }

  saveResponse(key: MeshRequestKey, attemptId: string, response: unknown): Promise<boolean> {
    const row = meshRequestKeyOf(key);
    const record = this.database.meshRequests.get(row);
    if (record?.attemptId !== attemptId || record.response !== undefined)
      return Promise.resolve(false);
    this.database.meshRequests.set(row, { ...record, response: structuredClone(response) });
    return Promise.resolve(true);
  }

  deleteByKey(key: MeshRequestKey, attemptId: string): Promise<boolean> {
    const row = meshRequestKeyOf(key);
    if (this.database.meshRequests.get(row)?.attemptId !== attemptId) return Promise.resolve(false);
    this.database.meshRequests.delete(row);
    return Promise.resolve(true);
  }

  deleteExpired(now: Date): Promise<number> {
    let removed = 0;
    for (const [row, record] of this.database.meshRequests)
      if (
        Date.parse(record.expiresAt) <= now.getTime() &&
        (record.response !== undefined || Date.parse(record.lockedUntil) <= now.getTime())
      ) {
        this.database.meshRequests.delete(row);
        removed += 1;
      }
    return Promise.resolve(removed);
  }
}
