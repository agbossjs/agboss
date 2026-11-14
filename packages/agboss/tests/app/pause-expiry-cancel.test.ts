/**
 * #941 AC8: a cancel always beats an expiry. `app.cancel` after the deadline, before the look:
 * the run is cancelled, the pause `Expired`, the channel hears expired (I3). A cancel request found
 * when the look takes the tree — or written while the channel's handler runs — ends the tree as
 * cancelled: the channel is not asked (or its decision is dropped), no step of the failed or the
 * decided path runs.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { CANCEL_REQUEST_KEY } from "../../src/app/cancel-requests.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ExecutionTreeRepository, PauseResolution, PauseStatus } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { hours } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  ShortExpiryWorkflowStart,
  expiry,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication);
const THREAD = "cancel-1";

beforeEach(resetExpiry);
afterEach(() => {
  vi.restoreAllMocks();
});

const pausesOf = (rootExecutionId: string) =>
  expiryStore().findAllByTenantIdAndRootExecutionId("default", rootExecutionId);

/** The cancel request of `app.cancel` on a tree running elsewhere: the key its holder watches. */
const requestCancelOf = (app: TestApp, rootExecutionId: string) =>
  app
    .resolve(ExecutionTreeRepository)
    .saveIfAbsentInTree({ tenantId: "default", rootExecutionId }, CANCEL_REQUEST_KEY, {
      requestedAt: "2026-01-01T00:00:00.000Z",
      ownerId: null,
    });

describe("#941 AC8: a cancel beats an expiry", () => {
  test("AC8: app.cancel after the deadline, before the look: the run is cancelled, the pause Expired, the channel hears expired", async ({
    app,
    clock,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      { threadId: THREAD },
    );
    // the look finds nothing: the cancel comes first
    vi.spyOn(expiryStore(), "findPendingByExpiresAtBefore").mockResolvedValue([]);
    await clock.advance(hours(24));

    await app.cancel(THREAD);

    const [pause] = await pausesOf(paused.executionId);
    expect(pause).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
    });
    await until(() => expiry.closed.length === 1);
    expect(expiry.closed[0]?.reason).toBe("expired");
    expect(expiry.errors[0]).toBeInstanceOf(ExecutionCancelledError);
    expect(expiry.asked).toHaveLength(0);
    expect(expiry.directorAsked).toHaveLength(0);
  });

  test("AC8: a cancel request found when the look takes the tree: it ends cancelled, the channel is never asked, the escalation never runs", async ({
    app,
    clock,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      { threadId: THREAD },
    );
    await requestCancelOf(app, paused.executionId);

    await clock.advance(hours(24));
    await until(() => expiry.errors.length === 1);

    expect(expiry.errors[0]).toBeInstanceOf(ExecutionCancelledError);
    expect(expiry.asked).toHaveLength(0);
    expect(expiry.directorAsked).toHaveLength(0);
    const [pause] = await pausesOf(paused.executionId);
    expect(pause).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
    });
  });

  test("AC8: a cancel requested while the handler runs: its decision is dropped, the run ends cancelled, nothing of the decided path ran", async ({
    app,
    clock,
  }) => {
    const paused = await execute(
      app,
      ShortExpiryWorkflowStart,
      { orderId: "o-1" },
      { threadId: THREAD },
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    expiry.behavior = async () => {
      await gate;
      return PauseExpiration.decide({ approved: true, comment: "auto" });
    };

    await clock.advance(hours(4));
    await until(() => expiry.asked.length === 1);
    await requestCancelOf(app, paused.executionId);
    release();
    await until(() => expiry.errors.length === 1);

    expect(expiry.errors[0]).toBeInstanceOf(ExecutionCancelledError);
    expect(expiry.recorded).toEqual([]);
    expect(expiry.ended).toEqual([]);
    // the decision was never recorded: the tree's end closed the pause, `Expired` by its deadline
    const [pause] = await pausesOf(paused.executionId);
    expect(pause).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
    });
  });
});
