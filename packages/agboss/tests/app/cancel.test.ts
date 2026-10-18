import { beforeEach, describe, expect } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { NotPausedError, UnknownThreadError } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import {
  blocking,
  Charge,
  Clerk,
  ReceiptDto,
  resetSeen,
  seen,
  Start,
  Wait,
  CheckoutApplication,
} from "./fixtures/run-context.workflow.js";
import { execute } from "../helpers/flow.js";
import { ExecutionStatus } from "../../src/app/types.js";

const approve = { approved: true, by: "dana" };
const test = testWith(CheckoutApplication);

beforeEach(resetSeen);

/** Starts a run whose clerk waits in a long tool call; resolves with its thread once it waits. */
function waitingRun(run: () => Promise<unknown>): {
  done: Promise<unknown>;
  thread: Promise<string>;
} {
  const thread = new Promise<string>((resolve) => {
    blocking.started = resolve;
  });
  return { done: run(), thread };
}

describe("#187 AC1: after cancelling a paused run, approving it does not execute the tool", () => {
  test("cancel drops the pause: resume throws NotPausedError and the tool never runs", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, Start, { text: "charge" });

    const cancelled = await app.cancel(paused.threadId);
    const resumed = app.resume(paused.threadId, approve);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(cancelled).toEqual({ cancelled: true });
    await expect(resumed).rejects.toBeInstanceOf(NotPausedError);
    expect(seen.charges).toEqual([]);
    expect(seen.payments).toEqual([]);
    expect(await app.cancel(paused.threadId)).toEqual({ cancelled: false });
  });

  test("the cancel holds after a restart: the recovered app cannot resume it either", async ({
    app,
    recoverApp,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, Start, { text: "charge" });
    await app.cancel(paused.threadId);

    const restarted = await recoverApp();

    await expect(restarted.resume(paused.threadId, approve)).rejects.toBeInstanceOf(NotPausedError);
    expect(seen.charges).toEqual([]);
  });

  test("a thread with nothing running or paused is not cancelled", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(replyWith(ReceiptDto, { text: "nothing" }));
    const done = await execute(app, Start, { text: "hi" });

    expect(await app.cancel(done.threadId)).toEqual({ cancelled: false });
  });

  test("#261: a thread the tenant does not have is UnknownThreadError", async ({ app }) => {
    await expect(app.cancel("no-such-thread")).rejects.toBeInstanceOf(UnknownThreadError);
  });
});

describe("#187 AC2: cancelling a running run stops it before the next model/tool call", () => {
  test("cancel aborts executionContext.signal of the call in flight and the run rejects as cancelled", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Wait, { text: "a long job" }),
      replyWith(ReceiptDto, { text: "never" }),
    );
    const run = waitingRun(() => execute(app, Start, { text: "wait" }));
    const thread = await run.thread;

    const cancelled = await app.cancel(thread);

    expect(cancelled).toEqual({ cancelled: true });
    await expect(run.done).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.blocked).toHaveLength(1);
    expect(seen.blocked[0]?.aborted).toBe(true);
    expect(mockLlm(Clerk).requests).toHaveLength(1);
    expect(seen.payments).toEqual([]);
    await expect(app.resume(thread, approve)).rejects.toBeInstanceOf(NotPausedError);
  });

  test("a resumed run in flight is cancelled the same way", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "10 USD" }),
      callTool(Wait, { text: "a receipt" }),
      replyWith(ReceiptDto, { text: "never" }),
    );
    const paused = await execute(app, Start, { text: "charge, then wait" });
    const run = waitingRun(() => app.resume(paused.threadId, approve));
    await run.thread;

    expect(await app.cancel(paused.threadId)).toEqual({ cancelled: true });
    await expect(run.done).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.charges).toHaveLength(1);
    expect(mockLlm(Clerk).requests).toHaveLength(2);
    await expect(app.resume(paused.threadId, approve)).rejects.toBeInstanceOf(NotPausedError);
  });
});
