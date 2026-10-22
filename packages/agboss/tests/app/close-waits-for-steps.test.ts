/**
 * #367 — `app.close()` runs `onDestroy` and releases a tree's lease only after the step bodies its
 * interrupted pass left running returned (LangGraph's pass rejects before a body that ignores its
 * signal returns, #340 S2), up to the end of the shutdown timeout; a body still running then is
 * logged (`app.step-still-running`) and the close goes on.
 */
import { beforeEach, describe, expect } from "vitest";
import { ApplicationStoppingError } from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
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

/**
 * Starts an execution on `app` whose body ignores its signal, then stops `app` and interrupts the
 * execution at once (`close()` with the shutdown timeout, then `close({ timeout: 0 })`): the pass
 * rejects, the body is left running.
 */
async function interruptedWhileTheBodyRuns(
  app: TestApp,
  start: typeof SlowWorkflowStart | typeof ToolWorkflowStart = SlowWorkflowStart,
): Promise<Interrupted> {
  const started = firstBodyStarted();
  const call = execute(app, start, { text: "the job" });
  call.catch(() => undefined);
  await started;
  const closed = app.close();
  void app.close({ timeout: seconds(0) });
  await settle();
  return { call, closed };
}

describe("#367 AC1: the close waits for a body its interrupted pass left running", () => {
  test("onDestroy and the lease release wait for a body that returns after its pass rejected", async ({
    app,
  }) => {
    await app.ready();
    const { call, closed } = await interruptedWhileTheBodyRuns(app);

    expect(order).toEqual(["action 1 started", "action 1 sees the abort"]);
    bodies.letGo?.();
    await closed;

    await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
    expect(order.slice(2)).toEqual([
      "action 1 returned",
      "lease released by instance-1",
      "onDestroy",
    ]);
    expect(logged.filter((entry) => entry.code === "app.step-still-running")).toEqual([]);
  });

  test("a tool's body: the agent's pass rejected, the close waits for the tool call", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(WorkerAgent).thenReturn(callTool(SlowTool, { text: "one" }));
    await app.ready();
    const { call, closed } = await interruptedWhileTheBodyRuns(app, ToolWorkflowStart);

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

describe("#367 AC2: a body that never returns", () => {
  test("the close ends at the shutdown timeout with app.step-still-running", async ({
    app,
    clock,
  }) => {
    await app.ready();
    let isClosed = false;
    const interrupted = await interruptedWhileTheBodyRuns(app);
    const closed = interrupted.closed.then(() => {
      isClosed = true;
    });

    await clock.advance(seconds(59));
    await settle();
    expect(isClosed).toBe(false);
    expect(order).not.toContain("onDestroy");

    await clock.advance(seconds(1));
    await closed;

    const [warning, ...more] = logged.filter((entry) => entry.code === "app.step-still-running");
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
      const { call, closed } = await interruptedWhileTheBodyRuns(instance(apps, 0));

      // the other instance's sweeps at 30 s and 60 s find the lease held: the stop renews it
      await clock.advance(seconds(31));
      await clock.advance(seconds(25));
      expect(bodies.runs).toBe(1);

      bodies.letGo?.();
      await closed;
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
