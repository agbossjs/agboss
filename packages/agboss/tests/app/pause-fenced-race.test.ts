/**
 * #1341c — an `Immediate` pause asked on another instance, whose fence refuses a write of the
 * holder before the holder is told (its next renewal): the refused write is the pause itself, not a
 * hand-over. The holder's call RESOLVES `Paused` with `isExternallyPaused` — it never rejects with
 * `ExecutionError.Fenced` — nothing is charged, the record is `paused`, and `app.unpause` continues
 * the tree from its checkpoint and charges once. The clock is the test's `VirtualClock`: no renewal
 * happens before the write.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ExecutionRecordRepository } from "../../src/index.js";
import { InterruptMode, PauseRequestState } from "../../src/app/interrupt-types.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { execute } from "../helpers/flow.js";
import { settle } from "./fixtures/fence-takeover.js";
import {
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import {
  behaviour,
  CancelFenceApplication,
  FenceChargeStart,
  resetSeen,
  seen,
} from "./fixtures/cancel-fence.workflow.js";

const test = testWith(CancelFenceApplication, { instances: 2 });
const THREAD = "t-1341c-race";

beforeEach(() => {
  resetFencedEffect();
  resetSeen();
  behaviour.isSwallowing = false;
});
afterEach(() => {
  letAllGo();
  vi.restoreAllMocks();
});

async function pair(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

describe("#1341c: a fenced write that races the holder of an Immediate pause", () => {
  test("the holder's call resolves Paused, nothing is charged, and unpause continues and charges once", async ({
    apps,
  }) => {
    const [first, second] = await pair(apps);
    gates.before = 1;
    const call = execute(first, FenceChargeStart, { text: "order-1" }, { threadId: THREAD });
    call.catch(() => undefined);
    await frozenRuns(1);

    // the other instance fences the holder's token; the holder is not told before its write
    const asked = await second.pause(THREAD, { mode: InterruptMode.Immediate, reason: "freeze" });
    letAllGo();
    const outcome = await call;
    await settle();

    expect(asked).toEqual({ state: PauseRequestState.Pausing });
    expect(outcome).toMatchObject({
      status: ExecutionStatus.Paused,
      isExternallyPaused: true,
      reason: "freeze",
    });
    expect(seen.charged).toEqual([]);
    const [record] = await first.resolve(ExecutionRecordRepository).lastTurns("default", THREAD, 1);
    expect(record?.status).toBe("paused");

    gates.before = 0;
    const resumed = await second.unpause(THREAD);

    expect(resumed.status).toBe(ExecutionStatus.Finished);
    expect(seen.charged).toEqual(["reservation-order-1"]);
  });
});
