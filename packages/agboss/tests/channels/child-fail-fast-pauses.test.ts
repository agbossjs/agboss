/**
 * #337 (Bug B) with #267 AC10: under `.toParallelWorkflows(…)` a child that fails aborts the launch
 * (`FailFast`), and a sibling child waiting on a channel has its pause withdrawn — the pause waits
 * inside the child, under the launch's branch (its `branchKeys`) — so the execution fails with the
 * child's error in the same call instead of resting paused.
 */
import { beforeEach, describe, expect } from "vitest";
import { ChildExecutionFailedError, PauseResolution, PauseStatus } from "../../src/index.js";
import {
  callTool,
  failWith,
  ModelFailure,
  testWith,
  type ModelRequest,
} from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChildBatchWorkflowStart,
  ChildPausesApplication,
  ChildRefundAgent,
} from "./fixtures/child-pauses.workflow.js";
import { askFor, orderOf } from "./fixtures/pause-scripts.js";
import { pauseStore, RefundTool, resetPauses, seen } from "./fixtures/pauses.workflow.js";

const test = testWith(ChildPausesApplication);

beforeEach(resetPauses);

/** Order A's child asks the desk; order B's child fails. */
const refundOrFail = (request: ModelRequest) =>
  orderOf(request) === "A"
    ? callTool(RefundTool, { orderId: "A" })
    : failWith(ModelFailure.Timeout);

describe("#337 Bug B: FailFast withdraws a paused sibling child's pause", () => {
  test("a child fails while its sibling child waits: the pause is withdrawn, the execution fails", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(refundOrFail);

    const run = execute(app, ChildBatchWorkflowStart, [{ orderId: "A" }, { orderId: "B" }]);

    await expect(run).rejects.toBeInstanceOf(ChildExecutionFailedError);
    const stored = await pauseStore().findByTenantIdAndPauseId("default", askFor("A").pauseId);
    expect(stored).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Withdrawn,
    });
    expect(seen.withdrawals).toMatchObject([
      { orderId: "A", resolution: PauseResolution.Withdrawn, executionId: stored?.executionId },
    ]);
    expect(seen.refunds).toEqual([]);
  });
});
