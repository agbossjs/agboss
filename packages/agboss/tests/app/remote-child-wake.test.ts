/**
 * #917 — a parent waiting for its `ChildPlacement.AnyInstance` child is woken by the child's
 * completion itself, not by the cleanup that follows it (the lease's retire, its end's
 * announcement): the clock is never advanced, so only the in-process wake-up can end the wait.
 */
import { describe, expect } from "vitest";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { holdChildRetires } from "./fixtures/hold-child-retires.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { settle } from "./fixtures/fence-takeover.js";
import {
  announceHold,
  RemoteChildYieldApplication,
  resetYield,
  YieldOneWorkflowFinish,
  YieldOneWorkflowStart,
  yieldSeen,
} from "./fixtures/remote-child-yield.workflow.js";

const test = testWith(RemoteChildYieldApplication, { instances: 2 });

const isRootStart = (line: string): boolean => line.startsWith("yield-one-workflow ");

describe("#917 AC1: the child's completion wakes its waiting parent", () => {
  test("AC1: the child completes, its lease cleanup is still held, the clock never advances — the parent still finishes", async ({
    apps,
  }) => {
    resetYield();
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("two instances");
    await b.ready();
    await a.ready();
    const rootOf = (): string | undefined => yieldSeen.starts.find(isRootStart)?.split(" ")[1];
    const hold = holdChildRetires(apps, rootOf);
    const call = execute(a, YieldOneWorkflowStart, { name: "quick", delay: 0, outcome: "ok" });
    await until(() => yieldSeen.starts.some(isRootStart), "the root's start");
    await until(() => hold.held.length === 1, "the child's retire held");

    const done = await Promise.race([
      call,
      new Promise<"hung">((resolve) => {
        setTimeout(() => {
          resolve("hung");
        }, 2000);
      }),
    ]);
    hold.release();
    expect(done).not.toBe("hung");
    expect(done).toFinishWith(YieldOneWorkflowFinish, { name: "quick" });
  });
});

/** Two instances, ready; the child's retire held when `isRetireHeld`; the announcement when `isAnnounceHeld`. */
async function runHeld(apps: readonly TestApp[], isRetireHeld: boolean, isAnnounceHeld: boolean) {
  resetYield();
  const [a, b] = apps;
  if (a === undefined || b === undefined) throw new Error("two instances");
  await b.ready();
  await a.ready();
  const rootOf = (): string | undefined => yieldSeen.starts.find(isRootStart)?.split(" ")[1];
  const hold = holdChildRetires(apps, rootOf);
  const releaseAnnounce = isAnnounceHeld ? announceHold.hold() : (): void => undefined;
  const call = execute(a, YieldOneWorkflowStart, { name: "quick", delay: 0, outcome: "ok" });
  if (isRetireHeld) await until(() => hold.held.length === 1, "the child's retire held");
  return { call, hold, releaseAnnounce, rootOf };
}

describe("#917: the child's end is announced before the parent continues", () => {
  test("AC1: its lease retire held, the clock never advances (the in-process wake only) — the parent ends the tree, the child's end came first, once", async ({
    apps,
  }) => {
    const { call, hold, rootOf } = await runHeld(apps, true, false);
    await call;
    const endsBefore = [...yieldSeen.ends];
    hold.release();
    await settle();

    expect(endsBefore).toHaveLength(2);
    expect(endsBefore.at(-1)).toBe(`yield-one-workflow ${rootOf() ?? ""}`);
    expect(yieldSeen.ends).toEqual(endsBefore);
  });

  test("AC1: its announcement held, the clock never advances (the in-process wake only) — the parent waits for it, then the child's end precedes the root's", async ({
    apps,
  }) => {
    const { call, hold, releaseAnnounce, rootOf } = await runHeld(apps, false, true);
    await until(() => announceHold.entered === 1, "the child's end in its announcement");
    const early = await Promise.race([call, new Promise((resolve) => setTimeout(resolve, 300))]);
    releaseAnnounce();
    await call;
    hold.release();

    expect(early).toBeUndefined();
    expect(yieldSeen.ends).toHaveLength(2);
    expect(yieldSeen.ends.at(-1)).toBe(`yield-one-workflow ${rootOf() ?? ""}`);
  });
});

describe("#917: no order is promised once the parent's fallback look runs", () => {
  test("its announcement held and the clock advanced — the parent's 1 s look reads the finished row and ends the root before the child's end is announced, which comes once, later", async ({
    apps,
    clock,
  }) => {
    const { call, hold, releaseAnnounce, rootOf } = await runHeld(apps, false, true);
    await until(() => announceHold.entered === 1, "the child's end in its announcement");
    for (let step = 0; step < 20 && yieldSeen.ends.length === 0; step += 1) {
      await clock.advance(seconds(1));
      await settle();
    }
    await call;
    const endsWhileHeld = [...yieldSeen.ends];
    releaseAnnounce();
    await until(() => yieldSeen.ends.length === 2, "the child's end, announced");
    hold.release();

    expect(endsWhileHeld).toEqual([`yield-one-workflow ${rootOf() ?? ""}`]);
    expect(yieldSeen.ends).toHaveLength(2);
  });
});

describe("#917 AC1: a close while a parent waits", () => {
  test("AC1: close() of both instances ends within the shutdown timeout on the Clock while the parent waits for its child", async ({
    apps,
    clock,
  }) => {
    resetYield();
    const [a, b] = apps;
    if (a === undefined || b === undefined) throw new Error("two instances");
    await b.ready();
    await a.ready();
    const call = execute(a, YieldOneWorkflowStart, { name: "gate", delay: 0, outcome: "ok" });
    call.catch(() => undefined);
    await until(() => yieldSeen.runs.length === 1, "the child at its gate");
    const closedAt = clock.now().getTime();
    const state = { isClosed: false };
    const closed = Promise.all([a.close(), b.close()]).then(() => {
      state.isClosed = true;
    });
    for (let step = 0; step < 6 && !state.isClosed; step += 1) await clock.advance(seconds(10));
    await until(() => state.isClosed, "the close");
    await closed;
    expect(clock.now().getTime() - closedAt).toBeLessThanOrEqual(seconds(60));
  });
});
