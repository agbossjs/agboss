/**
 * #1366: an instance's graceful stop — a running step body is warned about once, with its ids, never after the stop has
 * finished; a store call the stop gave up is logged; the stop's timer is cleared when the stop finishes and one `close` timeout
 * starts one timer; the listener the wait puts on the stop's end is removed when it is no longer needed.
 */
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { instancePartsOf } from "../../../src/application/instance-steps.js";
import type { FrameSpec } from "../../../src/flow/context/frame.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";

interface Warning {
  readonly code: string;
  readonly message: string;
  readonly fields: unknown;
}

async function stopOf(clock: VirtualClock) {
  const warnings: Warning[] = [];
  const assembled = { maxConcurrentSteps: undefined, compensationTimeout: 1, providers: [] };
  const log = {
    warn: (code: string, message: string, fields?: unknown) => {
      warnings.push({ code, message, fields });
    },
  };
  const stores = {
    executionTrees: {},
    childQueue: {},
    rateLimits: {},
    pausedExecutions: {},
  };
  const parts = await instancePartsOf(assembled as never, clock, log as never, stores as never, {
    application: { instanceId: "instance" },
  });
  return { parts, warnings };
}

const frameOf = (
  executionId: string,
  step: { nodeId: string; visitNumber: number; itemIndex?: number; callId?: string },
): FrameSpec =>
  ({ execution: { executionId, tenant: { tenantId: "acme" }, parent: undefined }, step }) as never;

const never = (): Promise<never> => new Promise(() => undefined);
const realTick = (ms: number): Promise<"late"> =>
  new Promise((resolve) =>
    setTimeout(() => {
      resolve("late");
    }, ms),
  );

describe("#1366: warnings for bodies still running at the stop", () => {
  it("settled warns once per body still running at the stop's end, with its ids", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());
    void parts.stepEntries.track(frameOf("e1", { nodeId: "n1", visitNumber: 2 }), never);
    void parts.stepEntries.track(
      frameOf("e2", { nodeId: "n2", visitNumber: 1, itemIndex: 4, callId: "call-9" }),
      never,
    );
    parts.stepsAtStop.endBy(seconds(0));

    await parts.stepsAtStop.settled();
    await parts.stepsAtStop.settled();

    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.code === "app.step-still-running")).toBe(true);
    expect(warnings.map((w) => w.fields)).toEqual([
      { executionId: "e1", tenantId: "acme" },
      { executionId: "e2", tenantId: "acme" },
    ]);
    const [plain, detailed] = warnings.map((w) => w.message);
    expect(plain).toContain("step n1 (visit 2) of execution e1");
    expect(plain).not.toContain("item");
    expect(plain).not.toContain("tool call");
    expect(detailed).toContain("step n2 (visit 1, item 4, tool call call-9) of execution e2");
  });

  it("settled returns on its own when every body returned, with no warning", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());
    await parts.stepEntries.track(frameOf("e1", { nodeId: "n", visitNumber: 1 }), () =>
      Promise.resolve(1),
    );

    await parts.stepsAtStop.settled();

    expect(warnings).toEqual([]);
  });

  it("release warns about the bodies still running, once, and no warning follows the stop's finish", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());
    void parts.stepEntries.track(frameOf("e1", { nodeId: "n1", visitNumber: 1 }), never);

    parts.stepsAtStop.release();
    expect(warnings).toHaveLength(1);

    void parts.stepEntries.track(frameOf("e2", { nodeId: "n2", visitNumber: 1 }), never);
    parts.stepsAtStop.endBy(seconds(0));
    await parts.stepsAtStop.settled();

    expect(warnings).toHaveLength(1);
  });
});

describe("#1366: the stop's timer", () => {
  it("a finished stop clears its timer: the end never comes", async () => {
    const clock = new VirtualClock();
    const { parts } = await stopOf(clock);

    parts.stepsAtStop.endBy(seconds(10));
    parts.stepsAtStop.release();
    await clock.advance(seconds(11));

    expect(parts.stepsAtStop.signal.aborted).toBe(false);
  });

  it("a close with the same timeout again starts no second timer", async () => {
    const clock = new VirtualClock();
    let started = 0;
    const sleep = clock.sleep.bind(clock);
    clock.sleep = (delay, signal) => {
      started += 1;
      return sleep(delay, signal);
    };
    const { parts } = await stopOf(clock);

    parts.stepsAtStop.endBy(seconds(10));
    parts.stepsAtStop.endBy(seconds(10));

    expect(started).toBe(1);
  });
});

describe("#1366: the wait for what the stop awaits", () => {
  it("gives up and logs the store call at the stop's end when the wait is not answered", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());
    parts.stepsAtStop.endBy(seconds(0));

    await parts.stepsAtStop.within(never(), "the lease release");

    expect(warnings.map((w) => w.code)).toEqual(["app.stop-store-call-pending"]);
    expect(warnings[0]?.message).toContain("the lease release");
  });

  it("names the recovery sweep or the child workers when it is not told what it waits for", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());
    parts.stepsAtStop.endBy(seconds(0));

    await parts.stepsAtStop.within(never());

    expect(warnings[0]?.message).toContain("the recovery sweep or the child workers");
  });

  it("an end that comes while it waits releases it", async () => {
    const clock = new VirtualClock();
    const { parts, warnings } = await stopOf(clock);
    parts.stepsAtStop.endBy(seconds(5));
    const waited = parts.stepsAtStop.within(never());

    await clock.advance(seconds(6));
    const outcome = await Promise.race([waited.then(() => "done"), realTick(500)]);

    expect(outcome).toBe("done");
    expect(warnings).toHaveLength(1);
  });

  it("an answer before the end logs nothing and leaves no listener on the end", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());
    const { signal } = parts.stepsAtStop;

    await parts.stepsAtStop.within(Promise.resolve("answered"));

    expect(warnings).toEqual([]);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("an end that came while it waited leaves no listener behind", async () => {
    const { parts } = await stopOf(new VirtualClock());
    const { signal } = parts.stepsAtStop;
    const waited = parts.stepsAtStop.within(never());
    expect(getEventListeners(signal, "abort")).toHaveLength(1);

    parts.stepsAtStop.endBy(seconds(0));
    await waited;

    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("a wait started after the end gave up still gives up, and a late failure is dropped", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());
    parts.stepsAtStop.endBy(seconds(0));
    let fail: (error: Error) => void = () => undefined;
    const stopping = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });

    const outcome = await Promise.race([
      parts.stepsAtStop.within(stopping).then(() => "done"),
      realTick(500),
    ]);
    fail(new Error("late"));
    await realTick(10);

    expect(outcome).toBe("done");
    expect(warnings.map((w) => w.code)).toEqual(["app.stop-store-call-pending"]);
  });

  it("abandon logs the store call the stop gave up", async () => {
    const { parts, warnings } = await stopOf(new VirtualClock());

    parts.stepsAtStop.abandon("the lease");

    expect(warnings.map((w) => w.code)).toEqual(["app.stop-store-call-pending"]);
  });
});
