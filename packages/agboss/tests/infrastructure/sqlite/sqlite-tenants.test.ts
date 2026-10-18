/**
 * #261 PR 3 on the SQLite implementations (#265 S69 e): the paused executions are keyed by tenant +
 * thread and the checkpoints tagged with the run's tenant; a file written before tenants is
 * migrated — its rows in the tenant `"default"`.
 */
import { emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import type { PausedRun } from "../../../src/app/paused-runs.js";
import { PauseStatus } from "../../../src/infrastructure/paused-execution.repository.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import type { AgentExecutionOutput } from "../../../src/run/types.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const now = (): Date => new Date(0);

/** A paused run of a tenant's thread, as the app stores it. */
const pausedOf = (tenantId: string, threadId: string): PausedRun => ({
  // only the fields the store reads matter here
  run: {
    runId: `run-${tenantId}`,
    threadId,
    tenantId,
    ternId: "tern-1",
    status: ExecutionStatus.Paused,
    budgetUsd: 1,
  } as AgentExecutionOutput,
  workflowVersion: "1.0.0",
  configHash: "hash",
  status: PauseStatus.Pending,
});

describe("#261: SQLite paused executions are keyed by tenant + thread", () => {
  it("the same thread id in two tenants is two pauses; each resolves on its own", async () => {
    const paused = new SqlitePausedExecutionRepository(connectionTo(temporarySqlitePath()), now);
    await paused.save(pausedOf("acme", "thread-1"));
    await paused.save(pausedOf("globex", "thread-1"));

    const resolved = await paused.resolveByTenantIdAndThreadId("acme", "thread-1", { ok: true });

    expect(resolved?.run.runId).toBe("run-acme");
    expect(await paused.findByTenantIdAndThreadId("globex", "thread-1")).toMatchObject({
      status: PauseStatus.Pending,
    });
    await paused.deleteByTenantIdAndThreadId("acme", "thread-1");
    expect(await paused.findByTenantIdAndThreadId("acme", "thread-1")).toBeUndefined();
    expect(await paused.findByTenantIdAndThreadId("globex", "thread-1")).toBeDefined();
  });

  it("a file written before tenants is migrated: its pause is the tenant 'default''s", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE paused_executions (
      thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, run TEXT NOT NULL,
      workflow_version TEXT NOT NULL, config_hash TEXT NOT NULL, status TEXT NOT NULL,
      decision TEXT, paused_at TEXT NOT NULL);
      INSERT INTO paused_executions VALUES ('thread-1', 'run-1',
        '{"status":"paused","threadId":"thread-1","runId":"run-1","ternId":"t","budgetUsd":1}',
        '1.0.0', 'hash', 'pending', NULL, '1970-01-01T00:00:00.000Z');`);

    const paused = new SqlitePausedExecutionRepository(connectionTo(path), now);

    const found = await paused.findByTenantIdAndThreadId("default", "thread-1");
    expect(found?.run).toMatchObject({ runId: "run-1", tenantId: "default" });
    expect(await paused.findByTenantIdAndThreadId("acme", "thread-1")).toBeUndefined();
  });
});

describe("#261 AC6: SQLite checkpoints carry the run's tenant", () => {
  it("a checkpoint and its writes are tagged with configurable.tenant_id; an old file gets the column", async () => {
    const path = temporarySqlitePath();
    const old = connectionTo(path);
    old.database.exec(`CREATE TABLE checkpoints (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT, checkpoint_type TEXT NOT NULL, checkpoint BLOB NOT NULL,
      metadata_type TEXT NOT NULL, metadata BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));`);
    const connection = connectionTo(path);
    const saver = new SqliteCheckpointSaver(connection);
    const config = { configurable: { thread_id: "run-1", checkpoint_ns: "", tenant_id: "acme" } };

    const saved = await saver.put(config, emptyCheckpoint(), {
      source: "input",
      step: -1,
      parents: {},
    });
    await saver.putWrites(
      { configurable: { ...saved.configurable, tenant_id: "acme" } },
      [["channel", 1]],
      "task-1",
    );

    const rows = connection.database.prepare("SELECT tenant_id FROM checkpoints").all();
    const writes = connection.database.prepare("SELECT tenant_id FROM checkpoint_writes").all();
    expect(rows).toEqual([{ tenant_id: "acme" }]);
    expect(writes).toEqual([{ tenant_id: "acme" }]);
    expect((await saver.getTuple({ configurable: { thread_id: "run-1" } }))?.checkpoint.id).toBe(
      saved.configurable?.checkpoint_id,
    );
  });
});
