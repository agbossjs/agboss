/**
 * #810 — the SQLite A2A task store of a file written before #810: `a2a_tasks` without the
 * `mesh_body_hash` column. The store adds it when it opens the file; the tasks already there read
 * as untrusted (no body hash), a trusted one saved after keeps its own.
 */
import { describe, expect, it } from "vitest";
import { SqliteA2ATaskRepository } from "../../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { A2ATaskState } from "../../../src/infrastructure/a2a-task.repository.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");

const newTask = (taskId: string, meshBodyHash?: string) => ({
  tenantId: "default",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "order-workflow-start",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt: NINE,
  messageId: `m-${taskId}`,
  requestHash: "h-1",
  ...(meshBodyHash === undefined ? {} : { callerPeer: "orders-application", meshBodyHash }),
});

describe("#810: an A2A task file of before the mesh's body hash", () => {
  it("gains the column on open; its old tasks have none, a new trusted one keeps its own", async () => {
    const path = temporarySqlitePath();
    connectionTo(path).database.exec(`CREATE TABLE a2a_tasks (
      tenant_id TEXT NOT NULL, task_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      context_id TEXT NOT NULL, skill TEXT NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL,
      version INTEGER NOT NULL, accepted_at TEXT NOT NULL, status_at TEXT NOT NULL, caller_peer TEXT,
      PRIMARY KEY (tenant_id, task_id));
      INSERT INTO a2a_tasks VALUES ('default', 'old', 'alice', 'ctx-0', 'order-workflow-start',
        'TASK_STATE_SUBMITTED', '{"state":"TASK_STATE_SUBMITTED","pendingPauses":[]}', 1,
        '2026-01-05T09:00:00.000Z', '2026-01-05T09:00:00.000Z', NULL);`);
    const tasks = new SqliteA2ATaskRepository(connectionTo(path));
    const hash = `sha256:${"cd".repeat(32)}`;

    await tasks.saveIfAbsent(newTask("new", hash));

    const old = await tasks.findById({ tenantId: "default", taskId: "old" });
    expect(old).toBeDefined();
    expect(old).not.toHaveProperty("meshBodyHash");
    expect((await tasks.findById({ tenantId: "default", taskId: "new" }))?.meshBodyHash).toBe(hash);
  });
});
