import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  MESH_IN_PROGRESS_GRACE_MS,
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
  created_at: z.string(),
  expires_at: z.string(),
  response: z.string().nullable(),
});

const KEY = "tenant_id = ? AND peer = ? AND idempotency_key = ?";

/**
 * `MeshRequestRepository` on the application's SQLite file (#398 PR 2): one row per request (its tool, the hash of its
 * arguments, when it expires), its answer as JSON. `saveIfAbsent` is one `INSERT OR IGNORE` in a `BEGIN IMMEDIATE` transaction, so
 * of two instances admitting one key exactly one runs it. Listed in `@Application({ providers })`;
 * needs `sqlitePath`.
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
      const { changes } = this.connection.database
        .prepare("INSERT OR IGNORE INTO mesh_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          record.tenantId,
          record.peer,
          record.idempotencyKey,
          record.tool,
          record.requestHash,
          record.createdAt,
          record.expiresAt,
          record.response === undefined ? null : JSON.stringify(record.response),
        );
      return Number(changes) === 1;
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
      createdAt: parsed.created_at,
      expiresAt: parsed.expires_at,
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

  saveResponse(key: MeshRequestKey, response: unknown): Promise<void> {
    this.connection.database
      .prepare(`UPDATE mesh_requests SET response = ? WHERE ${KEY}`)
      .run(JSON.stringify(response), key.tenantId, key.peer, key.idempotencyKey);
    return Promise.resolve();
  }

  deleteByKey(key: MeshRequestKey): Promise<void> {
    this.connection.database
      .prepare(`DELETE FROM mesh_requests WHERE ${KEY}`)
      .run(key.tenantId, key.peer, key.idempotencyKey);
    return Promise.resolve();
  }

  deleteExpired(now: Date): Promise<number> {
    const { changes } = this.connection.database
      .prepare(
        "DELETE FROM mesh_requests WHERE (response IS NOT NULL AND expires_at <= ?) OR expires_at <= ?",
      )
      .run(now.toISOString(), new Date(now.getTime() - MESH_IN_PROGRESS_GRACE_MS).toISOString());
    return Promise.resolve(Number(changes));
  }
}

sqliteImplementation(SqliteMeshRequestRepository);
