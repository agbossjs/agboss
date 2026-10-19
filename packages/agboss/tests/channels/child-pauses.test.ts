/**
 * #267 × #263: a pause inside a child workflow is a pause of its root — listed in the root's
 * `result.pending` (with the child's execution id and, per item, its index), resumed by its
 * `pauseId`; the child goes on with the id it started with and its parent continues to its finish.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { ChildExecutionStatus, PauseAnswerer } from "../../src/index.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ChildBatchWorkflowFinish,
  ChildBatchWorkflowStart,
  ChildPausesApplication,
  ChildRefundAgent,
  RefundOneWorkflow,
  RefundOneWorkflowFinish,
  SingleChildWorkflowFinish,
  SingleChildWorkflowStart,
} from "./fixtures/child-pauses.workflow.js";
import { answerFor, approve, manager, orderOf, refunder } from "./fixtures/pause-scripts.js";
import { ConfirmOrderTool, RefundDoneDto, resetPauses, seen } from "./fixtures/pauses.workflow.js";

const test = testWith(ChildPausesApplication);
const ORDERS = [{ orderId: "A" }, { orderId: "B" }, { orderId: "C" }];

beforeEach(resetPauses);

/** The customer confirms the order before the child answers. */
const confirmer = (request: ModelRequest) =>
  request.kind === "chat" && request.messages.some((line) => line.role === "tool")
    ? replyWith(RefundDoneDto, { orderId: orderOf(request) })
    : callTool(ConfirmOrderTool, { orderId: orderOf(request) });

describe("#267 × #263: a single child pauses", () => {
  test("the root lists the child's pause; its pauseId resumes the child and the parent finishes", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(confirmer);

    const paused = await execute(app, SingleChildWorkflowStart, { orderId: "A" });

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toEqual([
      {
        pauseId: expect.stringMatching(/^[0-9a-f]{32}$/),
        answeredBy: PauseAnswerer.ThreadOwner,
        agent: "child-refund-agent",
        channel: "order-confirmation-channel",
        childExecutionId: expect.any(String),
        itemIndex: undefined,
        ask: expect.objectContaining({ tool: "confirm_order", arguments: { orderId: "A" } }),
      },
    ]);
    expect(paused.pending[0]?.childExecutionId).not.toBe(paused.runId);
    const [pause] = paused.pending;

    const done = await app.resume({ pauseId: pause?.pauseId ?? "", decision: approve });

    expect(done).toFinishWith(SingleChildWorkflowFinish, { orderId: "A" });
    expect(done.pending).toEqual([]);
    expect(seen.confirmed).toEqual(["A"]);
    expect(done).toHaveChildExecutions(RefundOneWorkflow, [{ finish: RefundOneWorkflowFinish }]);
    // the child resumed with the id it paused with
    expect(done.children.map((child) => child.executionId)).toEqual([pause?.childExecutionId]);
    expect(seen.pauses.map((event) => event.executionId)).toEqual([paused.runId]);
  });
});

describe("#267 × #263: per-item children pause at once", () => {
  test("two children wait at once: both in the root's pending, each with its child and item", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(refunder(["B", "C"]));

    const paused = await execute(app, ChildBatchWorkflowStart, ORDERS);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    const byItem = [...paused.pending].sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
    expect(byItem).toEqual(
      ["B", "C"].map((orderId, index) => ({
        answeredBy: PauseAnswerer.Channel,
        agent: "child-refund-agent",
        channel: "refund-approval-channel",
        childExecutionId: expect.any(String),
        itemIndex: index + 1,
        ask: expect.objectContaining({ tool: "refund", arguments: { orderId } }),
      })),
    );
    expect(new Set(byItem.map((pause) => pause.childExecutionId)).size).toBe(2);
    expect(seen.asks.map((ask) => ask.orderId).sort()).toEqual(["B", "C"]);
    // the child that did not wait finished in the same pass
    expect(mockLlm(ChildRefundAgent).requests.map(orderOf).sort()).toEqual(["A", "B", "C"]);
    expect(seen.pauses).toHaveLength(1);
  });

  test("each pauseId resumes its child only; the last answer lets the parent join and finish", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ChildRefundAgent).thenAnswer(refunder(["B", "C"]));
    const paused = await execute(app, ChildBatchWorkflowStart, ORDERS);
    const waiting = new Map(paused.pending.map((pause) => [pause.itemIndex, pause]));

    const again = await app.resume(answerFor("C"), manager);

    expect(again).toMatchObject({ status: ExecutionStatus.Paused, runId: paused.runId });
    expect(again.pending.map((pause) => pause.itemIndex)).toEqual([1]);
    expect(again.pending[0]?.childExecutionId).toBe(waiting.get(1)?.childExecutionId);
    expect(seen.refunds).toEqual(["C"]);

    const done = await app.resume(answerFor("B"), manager);

    expect(done).toFinishWith(ChildBatchWorkflowFinish, { text: "A, B, C" });
    expect(done.pending).toEqual([]);
    expect(seen.refunds).toEqual(["C", "B"]);
    expect(seen.asks).toHaveLength(2);
    expect(done.children).toHaveLength(3);
    expect(done.children.every((child) => child.status === ChildExecutionStatus.Finished)).toBe(
      true,
    );
    const resumedIds = done.children
      .filter((child) => child.itemIndex !== 0)
      .map((child) => child.executionId)
      .sort();
    expect(resumedIds).toEqual(
      [waiting.get(1)?.childExecutionId, waiting.get(2)?.childExecutionId].sort(),
    );
  });
});
