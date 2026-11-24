import { describe, expect, it } from "vitest";
import { runResultOf } from "../../src/app/result.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { AGBossError } from "../../src/core/errors.js";
import { CostReport } from "../../src/finops/usage.js";
import { bareRecordOf, ComponentKind } from "../../src/flow/runtime/records.js";

const finishRecordOf = (name: string) => bareRecordOf(name, ComponentKind.WorkflowFinish);

const runOf = (overrides: Record<string, unknown>) =>
  ({
    start: "start",
    startInput: {},
    path: ["start"],
    budgetUsd: 1,
    cost: CostReport.fromUsage([]),
    threadId: "t",
    tenantId: "default",
    turnId: "turn",
    runId: "r",
    data: { scope: {}, outdatedValues: [], lastError: null },
    pending: [],
    ...overrides,
  }) as never;

describe("#1341: a pass of the core as the app reports it", () => {
  it("a finished pass is Finished with its finish and output, and nothing pending", () => {
    const result = runResultOf(
      runOf({ status: ExecutionStatus.Finished, finish: "done", output: { id: "1" } }),
      false,
      finishRecordOf,
    );

    expect(result).toMatchObject({
      status: ExecutionStatus.Finished,
      output: { id: "1" },
      pending: [],
    });
    expect(result.finish?.name).toBe("done");
  });

  it("a paused pass is Paused with no finish and no output, whatever its fields held", () => {
    const result = runResultOf(
      runOf({ status: ExecutionStatus.Paused, finish: "done", output: { id: "1" } }),
      false,
      finishRecordOf,
    );

    expect(result.status).toBe(ExecutionStatus.Paused);
    expect(result.finish).toBeUndefined();
    expect(result.output).toBeUndefined();
  });

  it("a finished pass with no finish is a framework bug, never a result", () => {
    const run = runOf({ status: ExecutionStatus.Finished });

    expect(() => runResultOf(run, false, finishRecordOf)).toThrow(AGBossError);
  });
});
