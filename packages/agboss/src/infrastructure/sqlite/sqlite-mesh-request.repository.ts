import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import {
  MeshRequestRepository,
  type MeshRequestKey,
  type MeshRequestRecord,
} from "../mesh-request.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS mesh_requests (
  tenant_id TEXT NOT NULL, peer TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL, response TEXT,
  PRIMARY KEY (tenant_id, peer, idempotency_key));`;

const Row = z.object({
  tenant_id: z.string(),
  peer: z.string(),
  idempotency_key: z.string(),
  created_at: z.string(),
  response: z.string().nullable(),
});

const KEY = "tenant_id = ? AND peer = ? AND idempotency_key = ?";

/**
 * `MeshRequestRepository` on the application's SQLite file (#398 PR 2): one row per request, its
 * answer as JSON. `saveIfAbsent` is one `INSERT OR IGNORE` in a `BEGIN IMMEDIATE` transaction, so
 * of two instances admitting one key exactly one runs it. Listed in `@Application({ providers })`;
 * needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection] })
export class SqliteMeshRequestRepository extends MeshRequestRepository {
  constructor(private readonly connection: SqliteConnection) {
    super();
    connection.ensureSchema("mesh_requests", SCHEMA);
  }

  ping(): Promise<void> {
    return this.connection.ping();
  }

  saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    const saved = this.connection.transaction(() => {
      const { changes } = this.connection.database
        .prepare("INSERT OR IGNORE INTO mesh_requests VALUES (?, ?, ?, ?, NULL)")
        .run(record.tenantId, record.peer, record.idempotencyKey, record.createdAt);
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
      createdAt: parsed.created_at,
      ...(parsed.response === null ? {} : { response: JSON.parse(parsed.response) as unknown }),
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

  deleteCreatedBefore(cutoff: Date): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM mesh_requests WHERE created_at < ?")
      .run(cutoff.toISOString());
    return Promise.resolve();
  }
}

sqliteImplementation(SqliteMeshRequestRepository);
