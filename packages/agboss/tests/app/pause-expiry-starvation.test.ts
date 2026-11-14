/**
 * #1070, #1072: a pause nobody here can move stays pending, whatever the number of them: 55 due
 * pauses of another application's trees, or of trees another holder has the lease of, ahead of one
 * pause this instance can move do not hide it — it expires within one sweep, the others stay as
 * they were (and expire once their trees are free).
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { PauseResolution, PauseStatus } from "../../src/index.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { PauseExpiryBound } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { testWith } from "../../src/testing/index.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  ShortExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication);
/** More than one page of the look (`EXPIRY_PAGE` = 50). */
const STUCK = 55;

beforeEach(resetExpiry);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1072: due pauses no instance moves do not starve the ones behind them", () => {
  test("55 due pauses of another application's trees ahead of one movable pause: it expires within one sweep, the foreign ones stay pending", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const store = expiryStore();
    const deadline = new Date(clock.now().getTime() + hours(1)).toISOString();
    for (let n = 0; n < STUCK; n += 1) {
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
      { threadId: "starved-1" },
    );

    await clock.advance(hours(4) + minutes(1));
    await until(() => expiry.asked.length === 1);
    await clock.advance(seconds(10));

    const [pause] = await store.findAllByTenantIdAndRootExecutionId("default", movable.executionId);
    expect(pause?.resolution).toBe(PauseResolution.Expired);
    const foreign = await store.findPendingByExpiresAtBefore(clock.now(), 1000);
    expect(foreign).toHaveLength(STUCK);
  });

  test("55 due pauses of trees another holder has the lease of ahead of one movable pause: it expires, and the others expire once their trees are free", async ({
    app,
    clock,
  }) => {
    await app.ready();
    const leases = app.resolve(ExecutionLeaseRepository);
    const store = expiryStore();
    const held = [];
    for (let n = 0; n < STUCK; n += 1) {
      const paused = await execute(
        app,
        ShortExpiryWorkflowStart,
        { orderId: `held-${String(n)}` },
        { threadId: `held-${String(n)}` },
      );
      held.push(await leases.acquire("default", paused.executionId, hours(100)));
    }
    await clock.advance(hours(1));
    const movable = await execute(
      app,
      ShortExpiryWorkflowStart,
      { orderId: "o-free" },
      { threadId: "free-1" },
    );

    // the 55 held ones are due at 4 h, the free one at 5 h
    await clock.advance(hours(4));
    await until(() => expiry.asked.length === 1);
    await clock.advance(seconds(10));

    const [pause] = await store.findAllByTenantIdAndRootExecutionId("default", movable.executionId);
    expect(pause?.resolution).toBe(PauseResolution.Expired);
    expect(await store.findPendingByExpiresAtBefore(clock.now(), 1000)).toHaveLength(STUCK);

    for (const lease of held) if (lease !== undefined) await leases.release(lease);
    await clock.advance(seconds(10));
    await until(() => expiry.asked.length === STUCK + 1);
    await clock.advance(seconds(10));

    expect(await store.findPendingByExpiresAtBefore(clock.now(), 1000)).toHaveLength(0);
    expect(PauseStatus.Pending).toBe("pending");
  });
});
