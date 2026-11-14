/**
 * #1071: the expiry look starts each root's expiry and goes on — the channel's handler and the pass
 * that continues the run after it run beside the pause timers (not inside their tick): a 30 s
 * escalation step never makes `app.checkLiveness()` report the timers stuck, and the next due pause
 * is asked near its own deadline, not after the first one's escalation.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { HealthStatus } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  SlowExpiryWorkflowStart,
  expiry,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication);

beforeEach(resetExpiry);
afterEach(() => {
  vi.restoreAllMocks();
});

/** Time passing as a process lives it: in ticks, so the lease renewals and the looks run between them. */
async function passing(
  clock: { advance: (by: Milliseconds) => Promise<void> },
  total: Milliseconds,
) {
  for (let spent = 0; spent < total; spent += 5_000) await clock.advance(seconds(5));
}

describe("#1071: an expiry's pass does not run inside the pause timers' tick", () => {
  test("a 30 s escalation step after an expiry: liveness stays healthy while it runs", async ({
    app,
    clock,
  }) => {
    await execute(app, SlowExpiryWorkflowStart, { orderId: "o-0" }, { threadId: "slow-0" });

    await clock.advance(seconds(5));
    await until(() => expiry.slowStarted.length === 1);
    // 25 s into the 30 s step, far past the 15 s a tick may take before the timers read as stuck
    await passing(clock, seconds(25));
    const report = await app.checkLiveness();

    expect(expiry.slowEnded).toEqual([]);
    expect(report.status).toBe(HealthStatus.Healthy);
    await passing(clock, seconds(10));
    await until(() => expiry.slowEnded.length === 1);
  });

  test("two due pauses: both handlers start near their deadlines, the second not after the first's 30 s step", async ({
    app,
    clock,
  }) => {
    await execute(app, SlowExpiryWorkflowStart, { orderId: "o-0" }, { threadId: "slow-0" });
    await execute(app, SlowExpiryWorkflowStart, { orderId: "o-1" }, { threadId: "slow-1" });

    await passing(clock, seconds(10));
    await until(() => expiry.asked.length === 2);

    // both asked within the first ticks past the 3 s deadline, while o-0's step is still running
    expect(expiry.slowEnded).toEqual([]);
    expect(expiry.asked).toHaveLength(2);
    await until(() => expiry.slowStarted.length === 2);
    expect(expiry.slowEnded).toEqual([]);
    await passing(clock, seconds(40));
    await until(() => expiry.slowEnded.length === 2);
    expect([...expiry.slowStarted].sort()).toEqual(["o-0", "o-1"]);
  });
});
