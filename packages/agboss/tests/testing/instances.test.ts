/**
 * #265 PR 1 (#262 AC13 in its first form): `testWith(App, { instances: 2 })` — two application
 * instances, each its own container, over one set of stores and one clock; and the virtual clock
 * the framework's waits sleep on.
 */
import { describe, expect, it } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { createTestClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  LeaseApplication,
  OrderWorkflowStart,
  ReceiptDto,
} from "../infrastructure/fixtures/lease.workflow.js";

const test = testWith(LeaseApplication, { instances: 2 });

describe("testWith(App, { instances: 2 })", () => {
  test("apps[0] is app; both share the stores and the clock", async ({
    app,
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(
      callTool(Charge, { text: "1 USD" }),
      replyWith(ReceiptDto, { text: "Charged." }),
    );
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" });

    const cancelled = await apps[1]?.cancel(paused.thread);

    expect(apps).toHaveLength(2);
    expect(apps[0]).toBe(app);
    expect(apps[1]?.clock).toBe(clock);
    expect(cancelled).toEqual({ cancelled: true });
  });

  testWith(LeaseApplication, { instances: 0 }).fails(
    "instances must be a whole number ≥ 1",
    async ({ apps }) => {
      expect(apps).toHaveLength(0);
      await Promise.resolve();
    },
  );
});

describe("the virtual clock", () => {
  it("wakes the due sleeps in time order, takes durations with units, ends a sleep on abort", async () => {
    const clock = createTestClock();
    const woken: string[] = [];
    const stopped = new AbortController();
    const late = clock.timers.sleep(seconds(20)).then(() => woken.push("late"));
    const early = clock.timers.sleep(seconds(5)).then(() => woken.push("early"));
    const never = clock.timers.sleep(seconds(60), stopped.signal).then(() => woken.push("aborted"));

    await clock.advance(seconds(30));
    stopped.abort();
    await Promise.all([late, early, never]);

    expect(woken).toEqual(["early", "late", "aborted"]);
    expect(clock.now().toISOString()).toBe("2026-01-05T09:00:30.000Z");
    await clock.timers.sleep(seconds(1), stopped.signal);
  });
});
