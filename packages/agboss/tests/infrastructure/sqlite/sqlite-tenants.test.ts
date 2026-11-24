/**
 * #261 PR 3 on the SQLite implementations (#265 S69 e): the paused executions are keyed by tenant +
 * thread and the checkpoints tagged with the run's tenant.
 */
import { emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import type { PausedExecution } from "../../../src/app/paused-runs.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { pausedRunOfValue } from "../../../src/infrastructure/stored-run.js";
import { oldPausedRun } from "./pause-names-0.1.0.fixtures.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const clock = new VirtualClock(new Date(0));

/** A paused run of a tenant's thread, as the app stores it. */
const pausedOf = (tenantId: string, threadId: string): PausedExecution => ({
  run: pausedRunOfValue({
    ...oldPausedRun,
    runId: `run-${tenantId}`,
    threadId,
    tenantId,
    turnId: "turn-1",
    ternId: undefined,
  }),
  workflowVersion: "1.0.0",
  configHash: "hash",
});

describe("#261: SQLite paused executions are keyed by tenant + thread", () => {
  it("the same thread id in two tenants is two paused runs; each is found and deleted on its own", async () => {
    const paused = new SqlitePausedExecutionRepository(connectionTo(temporarySqlitePath()), clock);
    await paused.save(pausedOf("acme", "thread-1"));
    await paused.save(pausedOf("globex", "thread-1"));

    expect((await paused.findByTenantIdAndThreadId("acme", "thread-1"))?.run.runId).toBe(
      "run-acme",
    );
    expect((await paused.findByTenantIdAndThreadId("globex", "thread-1"))?.run.runId).toBe(
      "run-globex",
    );
    await paused.deleteByTenantIdAndThreadId("acme", "thread-1");
    expect(await paused.findByTenantIdAndThreadId("acme", "thread-1")).toBeUndefined();
    expect(await paused.findByTenantIdAndThreadId("globex", "thread-1")).toBeDefined();
  });
});

describe("#261 AC6: SQLite checkpoints carry the run's tenant", () => {
  it("a checkpoint and its writes are tagged with configurable.tenant_id", async () => {
    const path = temporarySqlitePath();
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
