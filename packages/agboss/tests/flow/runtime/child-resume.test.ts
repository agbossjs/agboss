import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError } from "../../../src/index.js";
import { ExecutionStatus } from "../../../src/app/types.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { ends, resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import { ItemResultDto, type ItemDto } from "./fixtures/fan-out.workflow.js";
import { recoveryRuns, resetRecoveryRuns } from "./fixtures/launch-recovery.workflow.js";
import {
  ChildrenApplication,
  childLog,
  ConfirmReviewTool,
  ItemReviewedWorkflowFinish,
  ItemReviewerAgent,
  resetChildLog,
  ReviewItemsWorkflowStart,
  ReviewOneWorkflowStart,
  ReviewsSummaryWorkflowFinish,
} from "./fixtures/children.workflow.js";
import {
  ChildRecoveryApplication,
  HoldItemsWorkflowStart,
} from "./fixtures/child-recovery.workflow.js";

/**
 * #263 S24 — a child's identity survives a pause, a restart and a crash: the same
 * `childExecutionId`, no second `onExecutionStart`, finished siblings not run again.
 */

const test = testWith(ChildrenApplication);
const instances = testWith(ChildRecoveryApplication, { instances: 2 });
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };
const approve = { approved: true, by: "dana" };
/** The answer to the one pause a paused execution lists (a thread owner's: its id is listed). */
const answerOf = (paused: { readonly pending: readonly { readonly pauseId?: string }[] }) => ({
  pauseId: paused.pending[0]?.pauseId ?? "",
  decision: approve,
});
const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });

const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

/** `b` asks for a confirmation first; every review answers with its item's name. */
const reviewer = (request: ModelRequest) => {
  const name = nameIn(request);
  const confirmed =
    request.kind === "chat" && request.messages.some((line) => line.role === "tool");
  return name === "b" && !confirmed
    ? callTool(ConfirmReviewTool, { name })
    : replyWith(ItemResultDto, { name });
};

const childStarts = (workflow: string): readonly string[] =>
  childLog.starts
    .filter((event) => event.workflow.name === workflow)
    .map((event) => event.executionId);

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

beforeEach(() => {
  resetChildLog();
  resetRecovery();
  resetRecoveryRuns();
});

describe("S24: a pause and a restart inside a single child", () => {
  test("a paused single child resumes with the same id", async ({ app, mockLlm }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);

    const paused = await execute(app, ReviewOneWorkflowStart, item("b"), who);
    const done = await app.resume(answerOf(paused), { tenantId: "acme" });

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(done).toFinishWith(ItemReviewedWorkflowFinish, { name: "b" });
    expect(childStarts("item-review-workflow")).toHaveLength(1);
    expect(done.children.map((child) => child.executionId)).toEqual(
      childStarts("item-review-workflow"),
    );
  });

  test("a paused child survives a restart: the new instance resumes it, same id", async ({
    app,
    recoverApp,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
    const paused = await execute(app, ReviewItemsWorkflowStart, [item("a"), item("b")], who);
    const before = mockLlm(ItemReviewerAgent).requests.length;

    const restarted = await recoverApp();
    const done = await restarted.resume(answerOf(paused), { tenantId: "acme" });

    expect(done).toFinishWith(ReviewsSummaryWorkflowFinish, { text: "a, b" });
    expect(mockLlm(ItemReviewerAgent).requests.slice(before).map(nameIn)).toEqual(["b"]);
    expect(childStarts("item-review-workflow")).toHaveLength(2);
    expect([...done.children.map((child) => child.executionId)].sort()).toEqual(
      [...childStarts("item-review-workflow")].sort(),
    );
  });
});

describe("S24: a crash inside a child", () => {
  instances(
    "a crash mid-child: the other instance continues only it, with the same id",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      const held = new Promise<void>((resolve) => {
        recoveryRuns.holdStarted = resolve;
      });
      const first = instance(apps, 0);
      const call = execute(first, HoldItemsWorkflowStart, [item("a"), item("hold"), item("c")]);
      call.catch(() => undefined);
      await held;

      await clock.advance(seconds(5));
      const closed = first.close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;
      await clock.advance(seconds(20));
      const seen = await ends(4);

      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      expect(seen.find((end) => end.finish === "summary-workflow-finish")?.output).toEqual({
        text: "a, hold, c",
      });
      expect([...recoveryRuns.runs].sort()).toEqual(["a", "c", "hold", "hold"]);
      // three children, three starts: the held one was continued, not started again
      expect(childStarts("hold-check-workflow")).toHaveLength(3);
    },
  );
});
