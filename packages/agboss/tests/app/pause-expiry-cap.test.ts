/**
 * #1092: with `maxConcurrentSteps` set, due pauses no instance can move (another application's
 * trees, trees another holder has) take no place of the cap: a movable pause behind 200 of them is
 * asked within one tick (5 s) of its deadline, not after ceil(200 / cap) ticks.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { PauseResolution } from "../../src/index.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { PauseExpiryBound } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { testWith } from "../../src/testing/index.js";
import { hours, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  CappedExpiryApplication,
  ShortExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(CappedExpiryApplication);

beforeEach(resetExpiry);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1092: unmovable due pauses take no place of maxConcurrentSteps", () => {
  test.for([200, 55])(
    "%i due pauses of another application's trees ahead of one movable pause, cap 4: its handler starts within one tick of its deadline",
    async (stuck, { app, clock }) => {
      await app.ready();
      const store = expiryStore();
      const deadline = new Date(clock.now().getTime() + hours(1)).toISOString();
      for (let n = 0; n < stuck; n += 1) {
        await store.findOrCreateByStepKey({
          ...pauseOf(`foreign-${String(n)}`, `foreign-run-${String(n)}:s:1:c`),
          rootExecutionId: `foreign-run-${String(n)}`,
          expiresAt: deadline,
          expiryBound: PauseExpiryBound.Pause,
        });
      }
      const movable = await execute(
        app,
        ShortExpiryWorkflowStart,
        { orderId: "o-1" },
        { threadId: "capped-1" },
      );

      // the movable pause is due at 4 h; the 5 s tick after it must ask the handler
      await clock.advance(hours(4));
      await clock.advance(seconds(5));
      await until(() => expiry.asked.length === 1);

      const [pause] = await store.findAllByTenantIdAndRootExecutionId(
        "default",
        movable.executionId,
      );
      expect(pause?.resolution).toBe(PauseResolution.Expired);
      expect(await store.findPendingByExpiresAtBefore(clock.now(), 1000)).toHaveLength(stuck);
    },
  );

  test("55 trees another holder has the lease of ahead of one movable pause, cap 4: its handler starts within one tick of its deadline", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const leases = app.resolve(ExecutionLeaseRepository);
    for (let n = 0; n < 55; n += 1) {
      const paused = await execute(
        app,
        ShortExpiryWorkflowStart,
        { orderId: `held-${String(n)}` },
        { threadId: `held-${String(n)}` },
      );
      await leases.acquire("default", paused.executionId, hours(100));
    }
    await execute(app, ShortExpiryWorkflowStart, { orderId: "o-free" }, { threadId: "free-1" });

    await clock.advance(hours(4));
    await clock.advance(seconds(5));
    await until(() => expiry.asked.length === 1);

    expect(expiry.asked[0]?.value).toMatchObject({ orderId: "o-free" });
  });
});
