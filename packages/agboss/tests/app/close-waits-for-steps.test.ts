/**
 * #367 — `app.close()` runs `onDestroy` and releases a tree's lease only after the step bodies its
 * interrupted pass left running returned (LangGraph's pass rejects before a body that ignores its
 * signal returns, #340 S2), up to the end of the shutdown timeout; a body still running then is
 * logged (`app.step-still-running`) and the close goes on. S3: one `close()` interrupts the
 * executions a grace before the timeout ends — `min(seconds(5), 20 %)`: 5 s of the fixture's 60 s
 * — and spends the grace on the bodies; `close({ timeout: 0 })` stops waiting for them at once.
 */
import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError } from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { passLive } from "../helpers/live-time.js";
import {
  bodies,
  CloseStepsApplication,
  firstBodyStarted,
  order,
  resetCloseSteps,
  SlowTool,
  SlowWorkflowStart,
  ToolWorkflowStart,
  WorkerAgent,
} from "./fixtures/close-steps.workflow.js";

const test = testWith(CloseStepsApplication);
const two = testWith(CloseStepsApplication, { instances: 2 });

beforeEach(() => {
  resetCloseSteps();
  resetRecovery();
  resetLogged();
});

/** Lets the pending promise callbacks run (no clock involved). */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The instance `index` of a test with several. */
const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** An execution interrupted by the stop while its body runs: its call and the close. */
interface Interrupted {
  /** The execution's call: rejects with `ApplicationStoppingError` once its lease is released. */
  readonly call: Promise<unknown>;
  readonly closed: Promise<void>;
}

/** The fixture's shutdown timeout and the moment one `close()` interrupts (its 5 s grace before). */
const SHUTDOWN_TIMEOUT = seconds(60);
const INTERRUPTED_AT = seconds(55);

/** Whether the first body has seen its execution's abort. */
const sawTheAbort = (): boolean => order.some((line) => line.endsWith("sees the abort"));

/**
 * Starts an execution on `app` whose body ignores its signal, then stops `app` with one `close()`
 * and moves the clock to its interruption, `shutdownTimeout − grace`: the pass rejects, the body
 * is left running.
 */
async function interruptedWhileTheBodyRuns(
  app: TestApp,
  clock: VirtualClock,
  start: typeof SlowWorkflowStart | typeof ToolWorkflowStart = SlowWorkflowStart,
): Promise<Interrupted> {
  const started = firstBodyStarted();
  const call = execute(app, start, { text: "the job" });
  call.catch(() => undefined);
  await started;
  const closed = app.close();
  await passLive(clock, INTERRUPTED_AT);
  await settle();
  return { call, closed };
}

/** The `app.step-still-running` warnings logged so far. */
const stillRunning = (): typeof logged => logged.filter((e) => e.code === "app.step-still-running");

describe("#367 AC1: the close waits for a body its interrupted pass left running", () => {
  test("onDestroy and the lease release wait for a body that returns within the grace", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const { call, closed } = await interruptedWhileTheBodyRuns(app, clock);

    expect(order).toEqual(["action 1 started", "action 1 sees the abort"]);
    bodies.letGo?.();
    await closed;

    await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
    expect(order.slice(2)).toEqual([
      "action 1 returned",
      "lease released by instance-1",
      "onDestroy",
    ]);
    expect(stillRunning()).toEqual([]);
  });

  test("a tool's body: the agent's pass rejected, the close waits for the tool call", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(WorkerAgent).thenReturn(callTool(SlowTool, { text: "one" }));
    await app.ready();
    const { call, closed } = await interruptedWhileTheBodyRuns(app, clock, ToolWorkflowStart);

    expect(order).toEqual(["tool 1 started", "tool 1 sees the abort"]);
    expect(order.some((line) => line.startsWith("lease released"))).toBe(false);
    bodies.letGo?.();
    await closed;

    await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
    expect(order.slice(2)).toEqual([
      "tool 1 returned",
      "lease released by instance-1",
      "onDestroy",
    ]);
  });
});

describe("#367 S3: the executions are interrupted a grace before the shutdown timeout ends", () => {
  test("one close(): interrupted at shutdownTimeout − grace on the Clock", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const started = firstBodyStarted();
    const call = execute(app, SlowWorkflowStart, { text: "the job" });
    call.catch(() => undefined);
    await started;
    const closedAt = clock.now().getTime();
    const closed = app.close();

    await passLive(clock, seconds(54));
    await settle();
    expect(sawTheAbort()).toBe(false);
    await clock.advance(seconds(1));
    await settle();

    expect(sawTheAbort()).toBe(true);
    expect(clock.now().getTime() - closedAt).toBe(SHUTDOWN_TIMEOUT - seconds(5));
    bodies.letGo?.();
    await closed;
    expect(clock.now().getTime() - closedAt).toBeLessThanOrEqual(SHUTDOWN_TIMEOUT);
  });

  test("a second close({ timeout: 0 }) during the grace: onDestroy at once", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const { call, closed } = await interruptedWhileTheBodyRuns(app, clock);

    await app.close({ timeout: seconds(0) });
    await closed;

    await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
    expect(order).toEqual([
      "action 1 started",
      "action 1 sees the abort",
      "lease released by instance-1",
      "onDestroy",
    ]);
    expect(stillRunning()).toHaveLength(1);
    bodies.letGo?.();
    await settle();
    expect(order.at(-1)).toBe("action 1 returned");
  });
});

describe("#367 AC2: a body that never returns", () => {
  test("the close ends at the shutdown timeout with app.step-still-running", async ({
    app,
    clock,
  }) => {
    await app.ready();
    let isClosed = false;
    const interrupted = await interruptedWhileTheBodyRuns(app, clock);
    const closed = interrupted.closed.then(() => {
      isClosed = true;
    });

    await clock.advance(seconds(4));
    await settle();
    expect(isClosed).toBe(false);
    expect(order).not.toContain("onDestroy");

    await clock.advance(seconds(1));
    await closed;

    const [warning, ...more] = stillRunning();
    expect(more).toEqual([]);
    expect(warning).toMatchObject({ level: "warn", tenantId: "default" });
    expect(warning?.message).toMatch(
      /^step slow-action \(visit 1\) of execution \S+ is still running at the end of the shutdown timeout/,
    );
    expect(warning?.executionId).toEqual(expect.any(String));
    await expect(interrupted.call).rejects.toBeInstanceOf(ApplicationStoppingError);
    expect(order).toEqual([
      "action 1 started",
      "action 1 sees the abort",
      "lease released by instance-1",
      "onDestroy",
    ]);
  });
});

describe("#367 AC3: another instance does not rerun a step whose body still runs", () => {
  two(
    "instances: 2 — the other instance does not rerun the step while the body runs",
    async ({ apps, clock }) => {
      for (const each of apps) await each.ready();
      const { call, closed } = await interruptedWhileTheBodyRuns(instance(apps, 0), clock);

      // the other instance's sweep at 30 s found the lease held; during the grace it still is
      await clock.advance(seconds(4));
      expect(bodies.runs).toBe(1);

      bodies.letGo?.();
      await closed;
      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      await clock.advance(seconds(30));
      const [recovered] = await ends(1);

      expect(recovered?.output).toEqual({ text: "done: the job" });
      expect(order).toEqual([
        "action 1 started",
        "action 1 sees the abort",
        "action 1 returned",
        "lease released by instance-1",
        "onDestroy",
        "action 2 started",
        "action 2 returned",
        "lease released by instance-2",
      ]);
    },
  );
});
