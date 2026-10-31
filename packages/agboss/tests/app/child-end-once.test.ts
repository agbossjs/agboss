/**
 * #562 — a child's end is announced once, by the pass that ended it: an `AnyInstance` child's finish
 * by the worker whose completion of its queue row won, a child on its parent's instance by the
 * parent's pass that ran it, a failure by the parent's pass that saw it — never by a parent that
 * re-enters its step after a takeover and only reads the end, and never by a holder whose lease is
 * no longer live. Before the fix, the parent's holder heard the child's end, froze before its step
 * was checkpointed, and the instance that took the tree over heard it again.
 */
import { beforeEach, describe, expect } from "vitest";
import {
  ExecutionCancelledError,
  ExecutionLeaseLostError,
  ExecutionRecordStatus,
} from "../../src/index.js";
import { testWith, type TestLeases } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import { childOf, item, statusOf } from "./fixtures/finished-work.js";
import {
  atChildEnd,
  ChildEndOnceApplication,
  ChildEndPoint,
  ChildEndWindowApplication,
  childrenIn,
  endOnceSeen,
  EndOnceLocalWorkflowStart,
  resetEndOnce,
  rootsIn,
} from "./fixtures/child-end-once.workflow.js";
import {
  openGate,
  resetYield,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(ChildEndOnceApplication, { instances: 2 });
const test3 = testWith(ChildEndOnceApplication, { instances: 3 });
const testWindow = testWith(ChildEndWindowApplication, { instances: 2 });

/** Where the child runs: queued for any instance, or in its parent's step. */
const PLACEMENTS = [
  { placement: "AnyInstance", start: YieldOneWorkflowStart },
  { placement: "ParentInstance", start: EndOnceLocalWorkflowStart },
] as const;

interface Fixtures {
  readonly clock: VirtualClock;
  readonly leases: TestLeases;
}

/** Every instance ready, the last first: `instance-1` is the last of `apps` (names follow starts). */
async function readyAll(apps: readonly TestApp[]): Promise<ReadonlyMap<string, TestApp>> {
  const order = [...apps].reverse();
  for (const app of order) await app.ready();
  return new Map(order.map((app, index) => [`instance-${String(index + 1)}`, app]));
}

/** `steps` times 10 s: every live holder renews, a frozen one's lease runs out and is recovered. */
async function liveFor(clock: VirtualClock, steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) await clock.advance(seconds(10));
}

/** `act` the first time only. */
const once = <T>(act: (value: T) => void): ((value: T) => void) => {
  let isDone = false;
  return (value) => {
    if (isDone) return;
    isDone = true;
    act(value);
  };
};

/** A promise the test opens. */
function gateOf(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Every child end and failure heard, and every root's. */
const heard = () => ({
  childEnds: childrenIn(endOnceSeen.ends),
  childErrors: childrenIn(endOnceSeen.errors),
  rootEnds: rootsIn(endOnceSeen.ends),
  rootErrors: rootsIn(endOnceSeen.errors),
});

/** The root's end or failure, wherever it was heard. */
const rootEnded = (): boolean =>
  rootsIn(endOnceSeen.ends).length + rootsIn(endOnceSeen.errors).length > 0;

/**
 * The parent runs on `a`; its child passes the gate and ends; at the child's first announcement `a`
 * freezes (its lease store and timers) before its step is checkpointed; another instance takes the
 * tree over and ends it; then `a` thaws. What `a`'s call ended with.
 */
async function frozenAfterChildEnd(
  a: TestApp,
  { clock, leases }: Fixtures,
  call: Promise<unknown>,
): Promise<unknown> {
  await until(() => yieldSeen.runs.length === 1, "the child at its gate");
  endOnceSeen.onChildEnd = once(() => {
    leases.stall(a);
  });
  openGate();
  await until(
    () => heard().childEnds.length + heard().childErrors.length > 0,
    "the child's end heard",
  );
  await liveFor(clock, 7);
  await until(rootEnded, "the tree ended where it was taken over");
  // the old holder thaws after the new holder finished
  leases.resume(a);
  const error = await rejectionOf(call);
  await settle();
  return error;
}

beforeEach(() => {
  resetYield();
  resetEndOnce();
  resetLogged();
});

describe("#562 AC1: the parent's holder freezes after its child ended, another instance takes the tree over", () => {
  for (const { placement, start } of PLACEMENTS) {
    test(`a ${placement} child that finished: its end heard once, the tree's once — the old holder, thawed, hears nothing`, async ({
      apps,
      clock,
      leases,
    }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      await readyAll(apps);
      const call = execute(a, start, item("gate"), { threadId: "thread-a" });
      const error = await frozenAfterChildEnd(a, { clock, leases }, call);

      const { childEnds, childErrors, rootEnds, rootErrors } = heard();
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(childEnds).toHaveLength(1);
      expect(childErrors).toEqual([]);
      expect(rootEnds).toHaveLength(1);
      expect(rootErrors).toEqual([]);
      // the gated step ran once: the tree was continued, the child never run again
      expect(yieldSeen.runs.map((run) => run.name)).toEqual(["gate"]);
    });

    test(`a ${placement} child that failed: its failure heard once, the tree's once`, async ({
      apps,
      clock,
      leases,
    }) => {
      const [a] = apps;
      if (a === undefined) throw new Error("two instances");
      await readyAll(apps);
      const call = execute(a, start, item("gate", "fail"), { threadId: "thread-a" });
      const error = await frozenAfterChildEnd(a, { clock, leases }, call);

      const { childEnds, childErrors, rootEnds, rootErrors } = heard();
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(childEnds).toEqual([]);
      expect(childErrors).toHaveLength(1);
      expect(rootEnds).toEqual([]);
      expect(rootErrors).toHaveLength(1);
    });
  }
});

describe("#562: a parent recovered twice", () => {
  for (const { placement, start } of PLACEMENTS) {
    test3(
      `a ${placement} child: the first two holders freeze after the child's end, the third ends the tree — the end heard once`,
      async ({ apps, clock, leases }) => {
        const [a] = apps;
        if (a === undefined) throw new Error("three instances");
        const byId = await readyAll(apps);
        const call = execute(a, start, item("gate"), { threadId: "thread-a" });
        // the first instance to take the tree over freezes too, before its step is checkpointed
        endOnceSeen.onRecovered = once((instanceId) => {
          const taker = byId.get(instanceId);
          if (taker !== undefined) leases.stall(taker);
        });
        const error = await frozenAfterChildEnd(a, { clock, leases }, call);
        for (const each of apps) leases.resume(each);
        await settle();

        const { childEnds, rootEnds } = heard();
        expect(error).toBeInstanceOf(ExecutionLeaseLostError);
        expect(childEnds).toHaveLength(1);
        expect(rootEnds).toHaveLength(1);
        expect(yieldSeen.runs.map((run) => run.name)).toEqual(["gate"]);
      },
    );
  }
});

describe("#562: a cancelled child", () => {
  for (const { placement, start } of PLACEMENTS) {
    test(`a ${placement} child cancelled at its gate: no end, its failure once, the tree's once`, async ({
      apps,
      clock,
    }) => {
      const [a, b] = apps;
      if (a === undefined || b === undefined) throw new Error("two instances");
      await readyAll(apps);
      const thread = `thread-${placement}`;
      // its rejection is taken at once: the call ends while the test still advances the clock
      const call = rejectionOf(execute(a, start, item("gate"), { threadId: thread }));
      await until(() => yieldSeen.runs.length === 1, "the child at its gate");
      expect(await b.cancel(thread, { tenantId: "default" })).toEqual({ cancelled: true });
      // the holder looks for a cancel request at its renewals, a worker at its running child's (10 s)
      await clock.advance(seconds(10));
      const error = await call;
      // the tree's rows went with it; a remote child's worker stops it at its next look
      await clock.advance(seconds(10));
      openGate();
      await settle();

      const { childEnds, childErrors, rootEnds, rootErrors } = heard();
      expect(error).toBeInstanceOf(ExecutionCancelledError);
      expect(childEnds).toEqual([]);
      expect(childErrors).toMatchObject([{ error: "ExecutionCancelledError" }]);
      expect(rootEnds).toEqual([]);
      expect(rootErrors).toMatchObject([{ error: "ExecutionCancelledError" }]);
    });
  }
});

describe("#562: a cancel the worker finds first", () => {
  test("the worker stops a cancelled AnyInstance child and completes its row: its parent, which reads it, announces it — once", async ({
    apps,
    clock,
    leases,
  }) => {
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("two instances");
    await readyAll(apps);
    const call = rejectionOf(
      execute(a, YieldOneWorkflowStart, item("gate"), { threadId: "thread-r" }),
    );
    await until(() => yieldSeen.runs.length === 1, "the child at its gate");
    // the child runs on b (ready first); a's holder misses the request while frozen
    expect(yieldSeen.runs).toMatchObject([{ instanceId: "instance-1" }]);
    const child = childOf(a);
    leases.stall(a);
    expect(await b.cancel("thread-r", { tenantId: "default" })).toEqual({ cancelled: true });
    await clock.advance(seconds(10));
    await until(
      () => statusOf(a, child) === ExecutionRecordStatus.Failed,
      "the worker stopped the child, its row completed",
    );
    leases.resume(a);
    await call;
    await clock.advance(seconds(10));
    await settle();

    const { childEnds, childErrors } = heard();
    expect(childEnds).toEqual([]);
    expect(childErrors).toHaveLength(1);
    expect(heard().rootErrors).toHaveLength(1);
  });
});

describe("#562: the window between a child's durable end and its announcement (at most once)", () => {
  const WINDOWS = [
    { at: ChildEndPoint.Finish, outcome: "ok", heardOf: () => heard().childEnds },
    { at: ChildEndPoint.Error, outcome: "fail", heardOf: () => heard().childErrors },
  ] as const;
  for (const { at, outcome, heardOf } of WINDOWS) {
    testWindow(
      `the parent's holder freezes right after its child's ${at} became durable, before announcing it: the new holder only reads it, the thawed one stops at the announcement — not heard`,
      async ({ apps, clock, leases }) => {
        const [a] = apps;
        if (a === undefined) throw new Error("two instances");
        await readyAll(apps);
        const thaw = gateOf();
        atChildEnd(at, async () => {
          leases.stall(a);
          await thaw.opened;
        });
        const input = item("gate", outcome);
        const call = rejectionOf(
          execute(a, EndOnceLocalWorkflowStart, input, { threadId: "thread-w" }),
        );
        await until(() => yieldSeen.runs.length === 1, "the child at its gate");
        openGate();
        // a's lease runs out while it is frozen; the other instance takes the tree over and ends it
        await liveFor(clock, 7);
        await until(rootEnded, "the tree ended where it was taken over");
        // the old holder thaws after the new holder finished: past its lease, it announces nothing
        // its lease store and timers still frozen: only its own fence (#533) can stop it
        thaw.open();
        await settle();
        leases.resume(a);
        const error = await call;
        await settle();

        expect(error).toBeInstanceOf(ExecutionLeaseLostError);
        expect(heardOf()).toEqual([]);
        expect(heard().rootEnds.length + heard().rootErrors.length).toBe(1);
      },
    );
  }
});
