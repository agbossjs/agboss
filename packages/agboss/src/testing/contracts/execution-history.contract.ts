import { expect } from "vitest";
import { buildCostReport } from "../../finops/usage.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import {
  ExecutionHistoryStatus,
  type ExecutionHistoryRecord,
  type ExecutionHistoryRepository,
} from "../../infrastructure/execution-history.repository.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import type { ContractTarget } from "./seam.js";

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

const DAY = {
  from: new Date("2026-01-05T00:00:00.000Z"),
  to: new Date("2026-01-06T00:00:00.000Z"),
};
const ALL = { offset: 0, limit: 100 };

const idsOf = (records: readonly ExecutionHistoryRecord[]): string[] =>
  records.map((record) => record.executionId);

const HISTORY_CASES: readonly ContractCase<ExecutionHistoryRepository>[] = [
  {
    name: "a save replaces the record of its tenant and execution; the other instance reads it",
    run: async ({ first, second }) => {
      await first.save(recordOf("e1", { status: ExecutionHistoryStatus.Paused }));
      await first.save(recordOf("e1"));

      expect(await second.findByTenantIdAndExecutionId("acme", "e1")).toEqual(recordOf("e1"));
      expect(await second.findByTenantIdAndExecutionId("globex", "e1")).toBeUndefined();
    },
  },
  {
    name: "by id alone, every tenant's; by thread, oldest first",
    run: async ({ first, second }) => {
      await first.save(recordOf("e2", { startedAt: "2026-01-05T10:00:00.000Z" }));
      await first.save(recordOf("e1"));
      await first.save(recordOf("e1", { tenantId: "globex" }));
      await first.save(recordOf("e3", { threadId: "thread-2" }));

      const byId = await second.findAllByExecutionId("e1");
      expect(byId.map((found) => found.tenantId).sort()).toEqual(["acme", "globex"]);
      expect(idsOf(await second.findAllByTenantIdAndThreadId("acme", "thread-1"))).toEqual([
        "e1",
        "e2",
      ]);
    },
  },
  {
    name: "a period in pages, one tenant's or all, oldest first; its end excluded",
    run: async ({ first, second }) => {
      await first.save(recordOf("e1"));
      await first.save(recordOf("e2", { startedAt: "2026-01-05T11:00:00.000Z" }));
      await first.save(
        recordOf("e3", { tenantId: "globex", startedAt: "2026-01-05T10:00:00.000Z" }),
      );
      await first.save(recordOf("e4", { startedAt: "2026-01-06T00:00:00.000Z" }));

      const all = await second.findAllByStartedAtBetween(DAY.from, DAY.to, ALL);
      const page = await second.findAllByStartedAtBetween(DAY.from, DAY.to, {
        offset: 1,
        limit: 1,
      });
      const acme = await second.findAllByTenantIdAndStartedAtBetween("acme", DAY.from, DAY.to, ALL);
      expect(idsOf(all)).toEqual(["e1", "e3", "e2"]);
      expect(idsOf(page)).toEqual(["e3"]);
      expect(idsOf(acme)).toEqual(["e1", "e2"]);
    },
  },
  {
    name: nulCaseName("a record's input and output"),
    run: async ({ first, second }) => {
      const record = recordOf("e1", {
        input: { text: NUL_TEXT },
        output: { text: NUL_TEXT, parts: [NUL_TEXT] },
      });

      await first.save(record);

      expect(await second.findByTenantIdAndExecutionId("acme", "e1")).toEqual(record);
    },
  },
  {
    name: "the sweep removes what ended before its cutoff, never a record still paused",
    run: async ({ first, second }) => {
      await first.save(recordOf("e1"));
      await first.save(recordOf("e2", { endedAt: "2026-01-05T12:00:00.000Z" }));
      await first.save(recordOf("e3", { status: ExecutionHistoryStatus.Paused }));

      await second.deleteByEndedAtBefore(new Date("2026-01-05T10:00:00.000Z"));

      expect(idsOf(await first.findAllByTenantIdAndThreadId("acme", "thread-1"))).toEqual([
        "e2",
        "e3",
      ]);
    },
  },
];

/**
 * `ExecutionHistoryRepository` (#401 PR 1): the kept root executions. A save replaces the record
 * of its tenant and execution; a record is found by its tenant and id, by its id alone, by its
 * thread (oldest first), and in pages of a period; the sweep removes only what ended before its
 * cutoff.
 */
export function executionHistoryContract(target: ContractTarget<ExecutionHistoryRepository>): void {
  registerContract("execution history contract", target, [{ cases: HISTORY_CASES }], pingOf);
}
