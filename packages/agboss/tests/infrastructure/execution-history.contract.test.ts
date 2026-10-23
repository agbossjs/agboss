/**
 * #401 PR 1: `ExecutionHistoryRepository` — the kept root executions. A save replaces the record of
 * its tenant and execution; a record is found by its tenant and id, by its id alone, by its thread
 * (oldest first), and in pages of a period (one tenant, or all); the sweep removes only the records
 * that ended before its cutoff. One suite, run against the in-memory default (two instances over
 * one database) and `SqliteExecutionHistoryRepository` (two instances on one file).
 */
import { describe, expect, it } from "vitest";
import {
  ExecutionHistoryRepository,
  ExecutionHistoryStatus,
  InMemoryExecutionHistoryRepository,
  type ExecutionHistoryRecord,
} from "../../src/infrastructure/execution-history.repository.js";
import { SqliteExecutionHistoryRepository } from "../../src/infrastructure/sqlite/sqlite-execution-history.repository.js";
import { storeKinds } from "./contracts/store-kinds.js";
import { buildCostReport } from "../../src/finops/usage.js";
import { bareRecordOf, ComponentKind } from "../../src/flow/runtime/records.js";

/** A record of the desk's execution — ended at 09:00:05 unless it rests paused. */
const recordOf = (
  executionId: string,
  fields: Partial<ExecutionHistoryRecord> = {},
): ExecutionHistoryRecord => ({
  path: ["desk-workflow-start", "desk-agent", "desk-workflow-finish"],
  scope: [],
  outdatedValues: [],
  spend: buildCostReport([]),
  children: [],
  pauses: [],
  compensations: [],
  toolCalls: [],
  steps: [],
  executionId,
  rootExecutionId: executionId,
  threadId: "thread-1",
  tenantId: "acme",
  application: { name: "desk-application", version: "1.0.0", instanceId: "instance-1" },
  workflow: {
    name: "desk-workflow",
    version: "1.0.0",
    startedVersion: "1.0.0",
    configHash: "c0ffee",
  },
  status: ExecutionHistoryStatus.Finished,
  startedAt: "2026-01-05T09:00:00.000Z",
  ...(fields.status === ExecutionHistoryStatus.Paused
    ? {}
    : { endedAt: "2026-01-05T09:00:05.000Z" }),
  start: bareRecordOf("desk-workflow-start", ComponentKind.WorkflowStart),
  input: { text: "where is order 7?" },
  contexts: { tenant: { tenantId: "acme" }, execution: {} },
  ...fields,
});

const kinds = storeKinds<ExecutionHistoryRepository>({
  inMemory: ({ database }) => new InMemoryExecutionHistoryRepository(database),
  sqlite: ({ connection }) => new SqliteExecutionHistoryRepository(connection()),
});

const DAY = {
  from: new Date("2026-01-05T00:00:00.000Z"),
  to: new Date("2026-01-06T00:00:00.000Z"),
};
const ALL = { offset: 0, limit: 100 };

describe.each(kinds)("#401 PR 1: ExecutionHistoryRepository ($name)", ({ twoInstances }) => {
  it("a save replaces the record of its tenant and execution; the other instance reads it", async () => {
    const { first, second } = twoInstances();
    await first.save(recordOf("e1", { status: ExecutionHistoryStatus.Paused }));
    await first.save(recordOf("e1"));

    expect(await second.findByTenantIdAndExecutionId("acme", "e1")).toEqual(recordOf("e1"));
    expect(await second.findByTenantIdAndExecutionId("globex", "e1")).toBeUndefined();
  });

  it("by id alone, every tenant's; by thread, oldest first", async () => {
    const { first, second } = twoInstances();
    await first.save(recordOf("e2", { startedAt: "2026-01-05T10:00:00.000Z" }));
    await first.save(recordOf("e1"));
    await first.save(recordOf("e1", { tenantId: "globex" }));
    await first.save(recordOf("e3", { threadId: "thread-2" }));

    expect((await second.findAllByExecutionId("e1")).map((found) => found.tenantId).sort()).toEqual(
      ["acme", "globex"],
    );
    expect(
      (await second.findAllByTenantIdAndThreadId("acme", "thread-1")).map(
        (found) => found.executionId,
      ),
    ).toEqual(["e1", "e2"]);
  });

  it("a period in pages, one tenant's or all, oldest first; its end excluded", async () => {
    const { first, second } = twoInstances();
    await first.save(recordOf("e1"));
    await first.save(recordOf("e2", { startedAt: "2026-01-05T11:00:00.000Z" }));
    await first.save(recordOf("e3", { tenantId: "globex", startedAt: "2026-01-05T10:00:00.000Z" }));
    await first.save(recordOf("e4", { startedAt: "2026-01-06T00:00:00.000Z" }));

    const ids = (records: readonly ExecutionHistoryRecord[]) => records.map((r) => r.executionId);
    expect(ids(await second.findAllByStartedAtBetween(DAY.from, DAY.to, ALL))).toEqual([
      "e1",
      "e3",
      "e2",
    ]);
    expect(
      ids(await second.findAllByStartedAtBetween(DAY.from, DAY.to, { offset: 1, limit: 1 })),
    ).toEqual(["e3"]);
    expect(
      ids(await second.findAllByTenantIdAndStartedAtBetween("acme", DAY.from, DAY.to, ALL)),
    ).toEqual(["e1", "e2"]);
  });

  it("the sweep removes what ended before its cutoff, never a record still paused", async () => {
    const { first, second } = twoInstances();
    await first.save(recordOf("e1"));
    await first.save(recordOf("e2", { endedAt: "2026-01-05T12:00:00.000Z" }));
    await first.save(recordOf("e3", { status: ExecutionHistoryStatus.Paused }));

    await second.deleteByEndedAtBefore(new Date("2026-01-05T10:00:00.000Z"));

    const left = await first.findAllByTenantIdAndThreadId("acme", "thread-1");
    expect(left.map((found) => found.executionId)).toEqual(["e2", "e3"]);
  });
});
