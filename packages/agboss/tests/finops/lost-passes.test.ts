/**
 * #853 — which passes a recovery finds lost, and which tasks record them: only takeovers at the
 * head checkpoint from a lease that expired, each pass once; only tasks of the root graph's
 * superstep at that checkpoint that no lost pass wrote for. A paused task resumed, a task of a
 * child's graph, or one of a later superstep records none.
 */
import { describe, expect, it } from "vitest";
import {
  LOST_PASSES_KEY,
  lostPassesOf,
  lostTokensOfTask,
  unknownCostRecordsOf,
  type LostPasses,
} from "../../src/finops/lost-passes.js";
import { buildCostReport, CostSource, recordToolCost } from "../../src/finops/usage.js";

const takeover = (checkpointId: string | undefined, previousToken?: number) => ({
  kind: "takeover",
  checkpointId,
  previousToken,
});

describe("#853: the passes lost at a checkpoint", () => {
  it("AC2: each takeover at the head checkpoint from an expired lease, once, oldest first", () => {
    const rows = [
      takeover("c1", 1), // an earlier checkpoint: its step went on since
      takeover("c2", 3),
      { kind: "handed-over", checkpointId: "c2", previousToken: 9 },
      takeover("c2", 2),
      takeover("c2", 2), // the same lost pass, found twice
      takeover("c2"), // a lease released, or a store that names no holder
      takeover(undefined, 7),
    ];

    expect(lostPassesOf("root", "c2", rows, ["t1"])).toEqual({
      rootExecutionId: "root",
      checkpointId: "c2",
      tokens: [2, 3],
      settledTaskIds: new Set(["t1"]),
    });
  });

  it("AC2: none without a takeover there, or without a head checkpoint", () => {
    expect(lostPassesOf("root", "c2", [takeover("c1", 1)], [])).toBeUndefined();
    expect(lostPassesOf("root", undefined, [takeover("c2", 1)], [])).toBeUndefined();
  });
});

describe("#853: the tasks that record them", () => {
  const lost: LostPasses = {
    rootExecutionId: "root",
    checkpointId: "c2",
    tokens: [1, 2],
    settledTaskIds: new Set(["paused-task"]),
  };
  const configOf = (taskId: string, map: Record<string, string>, carried: unknown = lost) => ({
    configurable: { [LOST_PASSES_KEY]: carried, __pregel_task_id: taskId, checkpoint_map: map },
  });

  it("AC1: a task of the root's superstep at that checkpoint, with no write there", () => {
    expect(lostTokensOfTask(configOf("task", { "": "c2" }))).toEqual({ taskId: "task", lost });
  });

  it("AC2: a task a lost pass wrote for (paused, or finished) records none", () => {
    expect(lostTokensOfTask(configOf("paused-task", { "": "c2" })).lost).toBeUndefined();
  });

  it("AC2: a later superstep, a subgraph's task, or a pass that took nothing over records none", () => {
    expect(lostTokensOfTask(configOf("task", { "": "c3" })).lost).toBeUndefined();
    expect(lostTokensOfTask(configOf("task", { "": "c2", "agent:x": "s1" })).lost).toBeUndefined();
    expect(lostTokensOfTask(configOf("task", { "": "c2" }, null)).lost).toBeUndefined();
    expect(lostTokensOfTask(undefined).lost).toBeUndefined();
  });

  it("AC1: one record per lost pass: Unknown, no amount, keyed by execution, step and pass", () => {
    const now = new Date("2026-11-08T10:00:00.000Z");
    const step = { nodeId: "writer-agent", taskId: "task", caller: "agent:writer-agent" };

    const records = unknownCostRecordsOf(lost, step, now);

    expect(records.map((record) => record.ledgerKey)).toEqual([
      { id: "unknown:root:writer-agent:task:1", madeAt: now },
      { id: "unknown:root:writer-agent:task:2", madeAt: now },
    ]);
    expect(records.every((record) => record.costSource === CostSource.Unknown)).toBe(true);
    expect(records.every((record) => record.costUsd === 0)).toBe(true);
  });

  it("AC3: the report counts them apart from the known total and calls", () => {
    const step = { nodeId: "writer-agent", taskId: "task", caller: "agent:writer-agent" };
    const records = [...unknownCostRecordsOf(lost, step, new Date(0)), recordToolCost("x-tool", 2)];

    const report = buildCostReport(records);

    expect(report).toMatchObject({ totalUsd: 2, calls: 1, unknownCalls: 2 });
    expect(report.byCaller).toEqual({ "tool:x-tool": 2 });
    expect(report.byModel).not.toHaveProperty("unknown");
    expect(report.trace).toHaveLength(3);
  });
});
