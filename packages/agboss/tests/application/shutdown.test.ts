/**
 * #265 S51: the graceful stop waits for the running executions up to the shutdown timeout —
 * `@Application({ shutdownTimeout })`, overridden by `app.close({ timeout })`, default
 * `seconds(25)` — then interrupts them: each stops without failing (no `onError`), releases its
 * lease and its record stays `running` for recovery.
 */
import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError, ExecutionRecordStatus } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Clerk,
  Hold,
  levers,
  OrderWorkflowStart,
  QuickStopApplication,
  ReceiptDto,
  RecoveryApplication,
  resetRecovery,
  seen,
  stores,
} from "../infrastructure/fixtures/recovery.workflow.js";

const test = testWith(RecoveryApplication);
const quick = testWith(QuickStopApplication);

beforeEach(resetRecovery);

/** A call that settles only when its execution ends. */
interface StartedExecution {
  readonly call: Promise<unknown>;
}

/** Starts an execution that holds; resolves once it holds. */
async function holding(app: TestApp): Promise<StartedExecution> {
  const held = new Promise<void>((resolve) => {
    levers.holdStarted = resolve;
  });
  const call = execute(app, OrderWorkflowStart, { text: "hold" });
  call.catch(() => undefined);
  await held;
  return { call };
}

/** Whether the first hold was stopped (interrupted). */
const interrupted = (): boolean | undefined => seen.holds[0]?.aborted;

/** The `running` records now. */
async function runningRecords(): Promise<number> {
  const records = await stores.records?.findByStatus(ExecutionRecordStatus.Running, 10);
  return records?.length ?? 0;
}

const hold = callTool(Hold, { text: "a long job" });
const holdThenAnswer = [hold, replyWith(ReceiptDto, { text: "Done." })] as const;

describe("#265 S51: the stop waits for the running executions", () => {
  test("one that ends within the timeout ends normally", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(...holdThenAnswer);
    const started = await holding(app);

    const closed = app.close();
    levers.letGo?.();
    await closed;

    await expect(started.call).resolves.toMatchObject({ output: { text: "Done." } });
    expect(interrupted()).toBe(false);
    expect(await runningRecords()).toBe(0);
  });

  test("the default timeout is 25 s: then the execution is interrupted, stays running, no onError", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(hold); // interrupted while it holds: no answer
    const started = await holding(app);

    const closed = app.close();
    await clock.advance(seconds(24));
    const before = interrupted();
    await clock.advance(seconds(1));
    await closed;

    expect(before).toBe(false);
    await expect(started.call).rejects.toBeInstanceOf(ApplicationStoppingError);
    expect(interrupted()).toBe(true);
    expect(seen.errors).toEqual([]);
    expect(await runningRecords()).toBe(1);
  });
});

describe("#265 S51: the timeout is the application's, or the call's", () => {
  quick("@Application({ shutdownTimeout: seconds(5) })", async ({ app, clock, mockLlm }) => {
    mockLlm(Clerk).thenReturn(hold); // interrupted while it holds: no answer
    await holding(app);

    const closed = app.close();
    await clock.advance(seconds(5));
    await closed;

    expect(interrupted()).toBe(true);
  });

  quick("app.close({ timeout }) overrides it", async ({ app, clock, mockLlm }) => {
    mockLlm(Clerk).thenReturn(hold); // interrupted while it holds: no answer
    await holding(app);

    const closed = app.close({ timeout: seconds(10) });
    await clock.advance(seconds(5));
    const before = interrupted();
    await clock.advance(seconds(5));
    await closed;

    expect(before).toBe(false);
    expect(interrupted()).toBe(true);
  });

  test("a second close with a shorter timeout shortens the wait", async ({ app, mockLlm }) => {
    mockLlm(Clerk).thenReturn(hold); // interrupted while it holds: no answer
    await holding(app);

    const first = app.close();
    const second = app.close({ timeout: seconds(0) });
    await Promise.all([first, second]);

    expect(interrupted()).toBe(true);
  });
});
