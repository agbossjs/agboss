/**
 * #1318e — a timed-out @Action is outcome-unknown, signalled, fenced, and never blindly retried:
 * its `execute` may still finish after the timeout, so the step fails with `ActionOutcomeUnknown`
 * (nothing retries or undoes it), whether or not it went through `Idempotency`; a retry is the
 * flow's explicit `.onError`, safe for what went through `Idempotency`; the signal aborts at the timeout; a late write through the framework is refused.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { StepError } from "../../src/core/error-families/step-errors.js";
import { ExecutionContextUnavailableError } from "../../src/flow/context/errors.js";
import { execute } from "../helpers/flow.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import {
  ActionTimeoutApplication,
  GuardedStart,
  MixedRetryStart,
  MixedStart,
  resetSeen,
  seen,
  UnguardedStart,
} from "./fixtures/action-timeout.application.js";

const test = testWith(ActionTimeoutApplication);

/** Lets every settled promise and its continuations run. */
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((r) => setImmediate(r));
};

describe("#1318e: a timed-out @Action", () => {
  beforeEach(resetSeen);
  // an orphaned execute is let go, so none leaks into the next test
  afterEach(() => {
    seen.release();
  });

  test("the signal of its context aborts at the timeout, not before", async ({ app, clock }) => {
    const pending = execute(app, UnguardedStart, { text: "k" });
    const failed = expect(pending).rejects.toBeInstanceOf(StepError.ActionOutcomeUnknown);
    await clock.advance(seconds(1));
    await flush();
    expect(seen.signal?.aborted).toBe(false);
    await clock.advance(seconds(5));
    await failed;

    expect(seen.signal?.aborted).toBe(true);
  });

  test("an unguarded action's timeout is outcome-unknown, naming the step, and runs once", async ({
    app,
    clock,
  }) => {
    const pending = execute(app, UnguardedStart, { text: "k" });
    const failed = expect(pending).rejects.toMatchObject({
      code: "step.action.outcome-unknown",
      action: "unguarded-action",
    });
    await clock.advance(seconds(6));
    await failed;
    // it resolves late: nothing runs it again
    seen.release();
    await flush();

    expect(seen.entered).toBe(1);
  });

  test("a late write of the orphaned execute through the framework is refused", async ({
    app,
    clock,
  }) => {
    const pending = execute(app, UnguardedStart, { text: "k" });
    const failed = expect(pending).rejects.toBeInstanceOf(StepError.ActionOutcomeUnknown);
    await clock.advance(seconds(6));
    await failed;
    seen.release();
    await flush();

    expect(seen.lateError).toBeInstanceOf(ExecutionContextUnavailableError);
    expect(seen.lateRan).toBe(false);
  });

  test("a guarded action's timeout is outcome-unknown too", async ({ app, clock }) => {
    const first = execute(app, GuardedStart, { text: "order-1" });
    const failed = expect(first).rejects.toBeInstanceOf(StepError.ActionOutcomeUnknown);
    await clock.advance(seconds(6));
    await failed;
  });

  test("an action with a runOnce AND a raw effect that times out is outcome-unknown, not retried", async ({
    app,
    clock,
  }) => {
    const pending = execute(app, MixedStart, { text: "mixed-1" });
    const failed = expect(pending).rejects.toBeInstanceOf(StepError.ActionOutcomeUnknown);
    await clock.advance(seconds(6));
    await failed;
    seen.release();
    await flush();

    expect(seen.entered).toBe(1);
    expect(seen.rawEffects).toBe(1);
    expect(seen.effects).toBe(1);
  });

  test("an explicit onError retry re-runs the action; its runOnce part is deduped", async ({
    app,
    clock,
  }) => {
    const pending = execute(app, MixedRetryStart, { text: "mixed-2" });
    await flush();
    await clock.advance(seconds(6));
    await expect(pending).resolves.toMatchObject({ output: { text: "charged" } });
    seen.release();
    await flush();

    expect(seen.entered).toBe(2);
    // the runOnce effect happened once, the raw one is the flow's to own
    expect(seen.effects).toBe(1);
    expect(seen.rawEffects).toBe(2);
  });

  test("an explicit retry of a guarded action whose first attempt resolves late: the effect happens once", async ({
    app,
    clock,
  }) => {
    const first = execute(app, GuardedStart, { text: "order-2" });
    const failed = expect(first).rejects.toBeInstanceOf(StepError.ActionOutcomeUnknown);
    await clock.advance(seconds(6));
    await failed;

    const retry = execute(app, GuardedStart, { text: "order-2" });
    await flush();
    seen.release();
    await expect(retry).resolves.toMatchObject({ output: { text: "charged" } });
    await flush();

    expect(seen.effects).toBe(1);
  });
});
