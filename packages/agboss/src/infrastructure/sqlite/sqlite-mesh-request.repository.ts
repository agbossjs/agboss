import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  MeshRequestRepository,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "../mesh-request.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";
import { parsedStoredJson } from "../stored-step.js";

const Row = z.object({
  tenant_id: z.string(),
  peer: z.string(),
  idempotency_key: z.string(),
  tool: z.string(),
  request_hash: z.string(),
  attempt_id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  locked_until: z.string(),
  response: z.string().nullable(),
});

const KEY = "tenant_id = ? AND peer = ? AND idempotency_key = ?";

/**
 * `MeshRequestRepository` on the application's SQLite file (#398 PR 2): one row per request (its tool, the hash of its
 * arguments, when it expires), its answer as JSON. `saveIfAbsent` is one `INSERT OR IGNORE` in a `BEGIN IMMEDIATE` transaction, so
 * of two instances admitting one key exactly one runs it. On the application's `@DatabaseStorage({ driver: SqliteDriver({ path }) })`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteMeshRequestRepository extends MeshRequestRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    const saved = this.connection.transaction(() => {
      const { database } = this.connection;
      const { changes } = database
        .prepare("INSERT OR IGNORE INTO mesh_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          record.tenantId,
          record.peer,
          record.idempotencyKey,
          record.tool,
          record.requestHash,
          record.attemptId,
          record.createdAt,
          record.expiresAt,
          record.lockedUntil,
          record.response === undefined ? null : JSON.stringify(record.response),
        );
      if (Number(changes) === 1) return true;
      // a request whose lease lapsed, asked again as the same call, is taken over by this attempt
      const taken = database
        .prepare(
          `UPDATE mesh_requests SET attempt_id = ?, created_at = ?, locked_until = ?
           WHERE ${KEY} AND response IS NULL AND locked_until <= ? AND tool = ? AND request_hash = ?`,
        )
        .run(
          record.attemptId,
          record.createdAt,
          record.lockedUntil,
          record.tenantId,
          record.peer,
          record.idempotencyKey,
          record.createdAt,
          record.tool,
          record.requestHash,
        );
      return Number(taken.changes) === 1;
    });
    return Promise.resolve(saved);
  }

  findByKey(key: MeshRequestKey): Promise<MeshRequestRecord | undefined> {
    const row = this.connection.database
      .prepare(`SELECT * FROM mesh_requests WHERE ${KEY}`)
      .get(key.tenantId, key.peer, key.idempotencyKey);
    if (row === undefined) return Promise.resolve(undefined);
    const parsed = Row.parse(row);
    const record: MeshRequestRecord = {
      tenantId: parsed.tenant_id,
      peer: parsed.peer,
      idempotencyKey: parsed.idempotency_key,
      tool: parsed.tool,
      requestHash: parsed.request_hash,
      attemptId: parsed.attempt_id,
      createdAt: parsed.created_at,
      expiresAt: parsed.expires_at,
      lockedUntil: parsed.locked_until,
      ...(parsed.response === null
        ? {}
        : {
            response: parsedStoredJson({
              what: "mesh request response",
              text: parsed.response,
              ids: {
                peer: parsed.peer,
                idempotencyKey: parsed.idempotency_key,
              },
            }),
          }),
    };
    return Promise.resolve(record);
  }

  renewLease(key: MeshRequestKey, attemptId: string, lockedUntil: string): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(
        `UPDATE mesh_requests SET locked_until = ? WHERE ${KEY} AND attempt_id = ? AND response IS NULL`,
      )
      .run(lockedUntil, key.tenantId, key.peer, key.idempotencyKey, attemptId);
    return Promise.resolve(Number(changes) === 1);
  }

  saveResponse(key: MeshRequestKey, attemptId: string, response: unknown): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(
        `UPDATE mesh_requests SET response = ? WHERE ${KEY} AND attempt_id = ? AND response IS NULL`,
      )
      .run(JSON.stringify(response), key.tenantId, key.peer, key.idempotencyKey, attemptId);
    return Promise.resolve(Number(changes) === 1);
  }

  deleteByKey(key: MeshRequestKey, attemptId: string): Promise<boolean> {
    const { changes } = this.connection.database
      .prepare(`DELETE FROM mesh_requests WHERE ${KEY} AND attempt_id = ?`)
      .run(key.tenantId, key.peer, key.idempotencyKey, attemptId);
    return Promise.resolve(Number(changes) === 1);
  }

  deleteExpired(now: Date): Promise<number> {
    const at = now.toISOString();
    const { changes } = this.connection.database
      .prepare(
        "DELETE FROM mesh_requests WHERE expires_at <= ? AND (response IS NOT NULL OR locked_until <= ?)",
      )
      .run(at, at);
    return Promise.resolve(Number(changes));
  }
}

sqliteImplementation(SqliteMeshRequestRepository);
