/**
 * #265 PR 1 (Q58) and the concurrent resumes of #267 that rest on it: the tree's lease is held by
 * whoever moves the tree, on any instance; a resume records its decision first (`Pending →
 * Resolved`, atomic) and then waits for the lease; the holder takes decisions resolved meanwhile
 * (the drain); a holder frozen past the lease loses it silently and the waiting call goes on.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  NotPausedError,
  PauseStatus,
  type ExecutionOutput,
} from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute, answerOf } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  Hold,
  hooks,
  LeaseApplication,
  OrderWorkflowStart,
  ReceiptDto,
  resetLease,
  seen,
} from "./fixtures/lease.workflow.js";
import type { TestApp } from "../../src/testing/test-app.js";

const approve = { approved: true };
const test = testWith(LeaseApplication, { instances: 2 });

beforeEach(resetLease);

/** The second instance of the test (`instances: 2`). */
const second = (apps: readonly TestApp[]): TestApp => {
  const [, other] = apps;
  if (other === undefined) throw new Error("the test runs two instances");
  return other;
};

/**
 * When the tree's next pause is saved, the other instance answers it at once — while the holder
 * still holds the lease; the hook returns once that decision is recorded (`Resolved`), so the
 * holder finds it before it lets the tree rest. `answered.call` is the other instance's resume.
 */
function answerNextPauseFrom(other: TestApp): { call: Promise<ExecutionOutput> | undefined } {
  const answered: { call: Promise<ExecutionOutput> | undefined } = { call: undefined };
  hooks.afterSave = async (paused, repository) => {
    const [pending] = paused.run.pending;
    if (answered.call !== undefined || pending === undefined) return;
    const call = other.resume({ pauseId: pending.pauseId, decision: approve });
    call.catch(() => undefined);
    answered.call = call;
    for (let tick = 0; tick < 1000; tick += 1) {
      const stored = await repository.findByTenantIdAndPauseId(
        paused.run.tenantId,
        pending.pauseId,
      );
      if (stored?.status === PauseStatus.Resolved) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("the other instance never recorded its decision");
  };
  return answered;
}

describe("#265 AC11 / #267 AC12: a tree is moved by one lease holder at a time", () => {
  test("a pause made on one instance is resumed on the other", async ({ app, apps, mockLlm }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

    const resumed = await second(apps).resume(answerOf(paused, approve));

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(resumed.output).toEqual({ text: "Charged." });
    expect(seen.charges).toEqual(["10 USD"]);
  });

  test("two resumes of one pause at once: one moves the tree, the other gets NotPausedError", async ({
    app,
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

    const [first, double] = await Promise.allSettled([
      app.resume(answerOf(paused, approve)),
      second(apps).resume(answerOf(paused, approve)),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(double.status === "rejected" ? double.reason : double.value).toBeInstanceOf(
      NotPausedError,
    );
    expect(seen.charges).toEqual(["10 USD"]);
  });
});

describe("#267 AC12 (Q58): a resume while the tree moves waits; the holder takes its decision", () => {
  test("the holder drains the decision recorded meanwhile; both calls return the tree's output", async ({
    app,
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "first" }),
      callTool(Charge, { text: "second" }),
      replyWith(ReceiptDto, { text: "Charged twice." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge twice" });
    const answered = answerNextPauseFrom(second(apps));

    const moved = await app.resume(answerOf(paused, approve));
    const waited = await answered.call;

    expect(moved.output).toEqual({ text: "Charged twice." });
    expect(waited?.status).toBe(ExecutionStatus.Finished);
    expect(waited?.output).toEqual({ text: "Charged twice." });
    expect(waited?.executionId).toBe(paused.executionId);
    expect(seen.charges).toEqual(["first", "second"]);
    expect(seen.resumes).toEqual([approve, approve]);
  });
});

describe("#265 AC11 (Q58): a holder frozen past the lease loses it, the waiting call goes on", () => {
  test("its call rejects with ExecutionLeaseLostError, no onError, no failed record; the other finishes the tree", async ({
    app,
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "first" }),
      callTool(Charge, { text: "second" }),
      callTool(Hold, { text: "a long job" }),
      replyWith(ReceiptDto, { text: "Done." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge, then hold" });
    const answered = answerNextPauseFrom(second(apps));
    const holding = new Promise<void>((resolve) => {
      hooks.holdStarted = resolve;
    });
    const frozen = app.resume(answerOf(paused, approve));
    frozen.catch(() => undefined);
    await holding;

    await clock.advance(seconds(31));

    await expect(frozen).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    const taken = await answered.call;
    expect(taken?.output).toEqual({ text: "Done." });
    expect(seen.holds.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(seen.errors).toEqual([]);
    expect(seen.completed).not.toContain("failed");
    expect(seen.appended).not.toContain("failed");
    expect(seen.charges).toEqual(["first", "second"]);
  });
});

describe("#265 S66 h: a resume's late `running` write never lands over the holder's end", () => {
  test("the holder finishes the tree first: the resume's compare-and-set write does not land, the record stays answered", async ({
    app,
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "first" }),
      callTool(Charge, { text: "second" }),
      replyWith(ReceiptDto, { text: "Charged twice." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge twice" });
    const answered = answerNextPauseFrom(second(apps));
    hooks.beforeGuardedWrite = async () => {
      // the first resume's own write goes at once; the other's waits until the holder ended the tree
      if (seen.guarded.length === 0) return;
      for (let tick = 0; tick < 1000 && !seen.completed.includes("answered"); tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const moved = await app.resume(answerOf(paused, approve));
    const waited = await answered.call;
    await clock.advance(seconds(31));

    expect(seen.guarded).toEqual([
      { status: "running", landed: true },
      { status: "running", landed: false },
    ]);
    const [stored] = (await seen.records[0]?.lastTerns(paused.tenantId, paused.threadId, 1)) ?? [];
    expect(stored?.status).toBe("answered");
    expect(moved.output).toEqual({ text: "Charged twice." });
    expect(waited?.output).toEqual({ text: "Charged twice." });
    expect(seen.resumes).toEqual([approve, approve]);
  });
});
