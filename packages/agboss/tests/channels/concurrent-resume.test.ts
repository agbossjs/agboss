/**
 * #267 AC12 (Q58) with two instances: two resumes of different pauses of one tree at once — both
 * decisions are taken, no step runs twice, the tree is moved by one lease holder at a time and each
 * call returns the tree's output with its decision; two resumes of one `pauseId` — one moves the
 * tree, the other gets `NotPausedError`; a reply that arrives on another instance before `send`
 * returns is taken by the step at once, with no pause. The lease itself:
 * `tests/infrastructure/concurrent-resume.test.ts`.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus, type ExecutionOutput } from "../../src/app/types.js";
import { NotPausedError, PauseStatus } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { execute } from "../helpers/flow.js";
import {
  BatchRefundAgent,
  BatchWorkflowFinish,
  BatchWorkflowStart,
  DeskClerkAgent,
  DeskWorkflowFinish,
  DeskWorkflowStart,
  hooks,
  pauseStore,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { answerFor, approve, manager, orderOf, refunder, until } from "./fixtures/pause-scripts.js";

const test = testWith(PausesApplication, { instances: 2 });
const ORDERS = [{ orderId: "A" }, { orderId: "B" }, { orderId: "C" }];

beforeEach(resetPauses);

/** The second instance of the test. */
const second = (apps: readonly TestApp[]): TestApp => {
  const [, other] = apps;
  if (other === undefined) throw new Error("the test runs two instances");
  return other;
};

describe("#267 AC12: concurrent resumes of one tree", () => {
  test("two pauses answered at once on two instances: both taken, no step twice", async ({
    app,
    apps,
    mockLlm,
  }) => {
    mockLlm(BatchRefundAgent).thenAnswer(refunder(["B", "C"]));
    const paused = await execute(app, BatchWorkflowStart, ORDERS);

    const results = await Promise.all([
      app.resume(answerFor("B"), manager),
      second(apps).resume(answerFor("C"), manager),
    ]);

    const finished = results.filter((result) => result.status === ExecutionStatus.Finished);
    expect(finished.length).toBeGreaterThanOrEqual(1);
    const last: ExecutionOutput | undefined = finished[0];
    expect(last).toFinishWith(BatchWorkflowFinish, { text: "A, B, C" });
    expect(results.map((result) => result.executionId)).toEqual([
      paused.executionId,
      paused.executionId,
    ]);
    expect([...seen.refunds].sort()).toEqual(["B", "C"]);
    expect(seen.asks).toHaveLength(2);
    expect(mockLlm(BatchRefundAgent).requests.map(orderOf).sort()).toEqual([
      "A",
      "B",
      "B",
      "C",
      "C",
    ]);
  });

  test("a double click: one resume moves the tree, the other gets NotPausedError", async ({
    app,
    apps,
    mockLlm,
  }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }), replyWith("Done."));
    await execute(app, DeskWorkflowStart, { text: "refund 7" });

    const [first, double] = await Promise.allSettled([
      app.resume(answerFor("7"), manager),
      second(apps).resume(answerFor("7"), manager),
    ]);

    const outcomes = [first, double].map((settled): unknown =>
      settled.status === "fulfilled" ? settled.value.status : (settled.reason as unknown),
    );
    expect(outcomes).toContainEqual(ExecutionStatus.Finished);
    expect(outcomes.find((outcome) => outcome instanceof Error)).toBeInstanceOf(NotPausedError);
    expect(seen.refunds).toEqual(["7"]);
  });

  test("a reply on the other instance before send returns: the step takes it, nothing pauses", async ({
    app,
    apps,
    mockLlm,
  }) => {
    const replies: Promise<ExecutionOutput>[] = [];
    hooks.beforeSendReturns = async (ask) => {
      const reply = second(apps).resume({ pauseId: ask.pauseId, decision: approve }, manager);
      reply.catch(() => undefined);
      replies.push(reply);
      await until(
        async () =>
          (await pauseStore().findByTenantIdAndPauseId("default", ask.pauseId))?.status ===
          PauseStatus.Resolved,
      );
    };
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }), replyWith("Done."));

    const done = await execute(app, DeskWorkflowStart, { text: "refund 7" });

    expect(done).toFinishWith(DeskWorkflowFinish, { text: "Done." });
    expect(seen.pauses).toEqual([]);
    expect(seen.refunds).toEqual(["7"]);
    expect(await replies[0]).toFinishWith(DeskWorkflowFinish, { text: "Done." });
  });
});
