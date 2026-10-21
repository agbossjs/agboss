/**
 * #267 AC1 / AC2: a pause stops only those who cannot go on without it — a paused branch does not
 * stop its siblings, the execution pauses when nothing else can move, and `result.pending` lists
 * every waiting pause; a pause is resumed by its id anywhere in the tree, and an execution with
 * other pauses left pauses again with the rest.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseAnswerer, UnknownPauseError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  BatchRefundAgent,
  BatchWorkflowFinish,
  BatchWorkflowStart,
  PausesApplication,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { answerFor, manager, orderOf, refunder } from "./fixtures/pause-scripts.js";

const test = testWith(PausesApplication);
const ORDERS = [{ orderId: "A" }, { orderId: "B" }, { orderId: "C" }];

beforeEach(resetPauses);

describe("#267 AC1: a paused branch does not stop its siblings", () => {
  test("the siblings finish in the same pass; pending lists every pause with its item", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BatchRefundAgent).thenAnswer(refunder(["B", "C"]));

    const paused = await execute(app, BatchWorkflowStart, ORDERS);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    const byItem = [...paused.pending].sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
    expect(byItem).toEqual(
      ["B", "C"].map((orderId, index) => ({
        answeredBy: PauseAnswerer.Channel,
        agent: "batch-refund-agent",
        channel: "refund-approval-channel",
        childExecutionId: undefined,
        itemIndex: index + 1,
        ask: expect.objectContaining({ tool: "refund-tool", arguments: { orderId } }),
      })),
    );
    expect(mockLlm(BatchRefundAgent).requests.map(orderOf).sort()).toEqual(["A", "B", "C"]);
    expect(seen.asks.map((ask) => ask.orderId).sort()).toEqual(["B", "C"]);
    expect(seen.pauses).toHaveLength(1);
    expect(seen.pauses[0]?.pending).toHaveLength(2);
  });
});

describe("#267 AC2: a pause is resumed by its id; the rest keep waiting", () => {
  test("one answer resumes its branch only: the execution pauses again with the other", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BatchRefundAgent).thenAnswer(refunder(["B", "C"]));
    const paused = await execute(app, BatchWorkflowStart, ORDERS);

    const again = await app.resume(answerFor("B"), manager);

    expect(again).toMatchObject({
      status: ExecutionStatus.Paused,
      threadId: paused.threadId,
      executionId: paused.executionId,
    });
    expect(again.pending.map((pause) => pause.itemIndex)).toEqual([2]);
    expect(seen.refunds).toEqual(["B"]);
    expect(seen.pauses).toHaveLength(2);
    expect(seen.pauses[1]?.pending).toHaveLength(1);
  });

  test("the last answer finishes it: each tool ran once, each channel was asked once", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BatchRefundAgent).thenAnswer(refunder(["B", "C"]));
    await execute(app, BatchWorkflowStart, ORDERS);
    await app.resume(answerFor("B"), manager);

    const done = await app.resume(answerFor("C"), manager);

    expect(done).toFinishWith(BatchWorkflowFinish, { text: "A, B, C" });
    expect(done.pending).toEqual([]);
    expect(seen.refunds).toEqual(["B", "C"]);
    expect(seen.asks).toHaveLength(2);
    expect(seen.resumes.map((event) => event.answeredBy)).toEqual(["manager-17", "manager-17"]);
  });

  test("an unknown pause and another tenant's are the same UnknownPauseError", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BatchRefundAgent).thenAnswer(refunder(["B"]));
    await execute(app, BatchWorkflowStart, ORDERS, { tenant: { tenantId: "acme" } });

    const otherTenant = app.resume(answerFor("B"), { ...manager, tenantId: "globex" });
    const unknown = app.resume(
      { ...answerFor("B"), pauseId: "f".repeat(32) },
      {
        ...manager,
        tenantId: "acme",
      },
    );

    await expect(otherTenant).rejects.toBeInstanceOf(UnknownPauseError);
    await expect(otherTenant).rejects.not.toThrow(/acme/);
    await expect(unknown).rejects.toBeInstanceOf(UnknownPauseError);
    expect(seen.refunds).toEqual([]);
  });
});
