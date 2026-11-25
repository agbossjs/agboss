/**
 * #1341c — `cancel()` after `pause(Immediate)`: the pause fenced the holder's token, the cancel's
 * unwind runs on a lease taken at a token above the fence (never by clearing the fence), and the
 * stale step stays fenced: nothing is charged, what was reserved is released exactly once.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { ExecutionRecordRepository } from "../../src/index.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { testWith } from "../../src/testing/index.js";
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

const test = testWith(CancelFenceApplication);
const THREAD = "t-1341c";

beforeEach(() => {
  resetFencedEffect();
  resetSeen();
  behaviour.isSwallowing = false;
});
afterEach(() => {
  letAllGo();
  vi.restoreAllMocks();
});

describe("#1341c: cancel within the window after pause(Immediate)", () => {
  test("the stale step stays fenced, the tree ends Cancelled on a fresh token, the reservation is released once", async ({
    app,
  }) => {
    gates.before = 1;
    const call = execute(app, FenceChargeStart, { text: "order-1" }, { threadId: THREAD });
    call.catch(() => undefined);
    await frozenRuns(1);
    await app.pause(THREAD, { mode: InterruptMode.Immediate });
    // the cancel comes within the window: the parked holder still holds its lease until the step
    // body in flight returns, so the cancel's unwind waits for it — as it always did
    const cancelling = app.cancel(THREAD, { reason: "withdrawn" });
    await settle();
    letAllGo();
    const outcome = await call;
    await cancelling;
    await settle();

    // the holder parked on the pause first (its caller was told), the cancel then ended the parked
    // tree on a lease at a token above the fence: its undo ran there, once
    expect([ExecutionStatus.Paused, ExecutionStatus.Cancelled]).toContain(outcome.status);
    expect(seen.charged).toEqual([]);
    expect(seen.reserved).toEqual(["order-1"]);
    expect(seen.released).toEqual(["reservation-order-1"]);
    // the thread ends cancelled, whichever of the two the caller was told first
    const [record] = await app.resolve(ExecutionRecordRepository).lastTurns("default", THREAD, 1);
    expect(record?.status).toBe("cancelled");
    expect(await app.cancel(THREAD)).toEqual({ cancelled: false });
  });
});
