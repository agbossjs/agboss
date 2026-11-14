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
import type { CancelOutput } from "../../src/app/types.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
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

  /** The public cancel racing the expiry: `app.cancel`, never the tree key (#1073). */
  describe("#1073: app.cancel racing an expiry", () => {
    /** `app.cancel(THREAD)`, started, and its mark durable in the lease store: the call is under way. */
    const cancelUnderWay = async (app: TestApp): Promise<{ result: Promise<CancelOutput> }> => {
      const leases = app.resolve(ExecutionLeaseRepository);
      const mark = leases.requestCancel.bind(leases);
      let marked: () => void = () => undefined;
      const isMarked = new Promise<void>((resolve) => {
        marked = resolve;
      });
      vi.spyOn(leases, "requestCancel").mockImplementation(async (tree) => {
        await mark(tree);
        marked();
      });
      const cancelled = app.cancel(THREAD);
      await isMarked;
      await new Promise((resolve) => setImmediate(resolve));
      return { result: cancelled };
    };

    const decide = () => PauseExpiration.decide({ approved: true, comment: "auto" });

    test("AC8: app.cancel while the handler runs: cancelled: true, the decision dropped, nothing of the decided path ran", async ({
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
        return decide();
      };
      await clock.advance(hours(4));
      await until(() => expiry.asked.length === 1);

      const { result: cancelled } = await cancelUnderWay(app);
      release();

      await expect(cancelled).resolves.toEqual({ cancelled: true });
      expect(expiry.errors[0]).toBeInstanceOf(ExecutionCancelledError);
      expect(expiry.recorded).toEqual([]);
      expect(expiry.ended).toEqual([]);
      const [pause] = await pausesOf(paused.executionId);
      expect(pause?.status).toBe(PauseStatus.Cancelled);
    });

    test("AC8: app.cancel while the handler runs, the handler failing into the escalation: the escalation never runs", async ({
      app,
      clock,
    }) => {
      await execute(app, ExpiryWorkflowStart, { orderId: "o-1" }, { threadId: THREAD });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      expiry.behavior = async () => {
        await gate;
        return PauseExpiration.fail();
      };
      await clock.advance(hours(24));
      await until(() => expiry.asked.length === 1);

      const { result: cancelled } = await cancelUnderWay(app);
      release();

      await expect(cancelled).resolves.toEqual({ cancelled: true });
      expect(expiry.directorAsked).toEqual([]);
      expect(expiry.errors[0]).toBeInstanceOf(ExecutionCancelledError);
    });

    test("AC8: app.cancel after the look read the due pauses, before it takes the tree: the handler is never asked", async ({
      app,
      clock,
    }) => {
      await execute(app, ShortExpiryWorkflowStart, { orderId: "o-1" }, { threadId: THREAD });
      const store = expiryStore();
      const read = store.findPendingByExpiresAtBefore.bind(store);
      let started: { result: Promise<CancelOutput> } | undefined;
      vi.spyOn(store, "findPendingByExpiresAtBefore").mockImplementation(async (...args) => {
        const due = await read(...args);
        if (due.length > 0) {
          started ??= await cancelUnderWay(app);
        }
        return due;
      });
      await clock.advance(hours(4));
      await until(() => started !== undefined);

      await expect(started?.result).resolves.toEqual({ cancelled: true });
      expect(expiry.asked).toEqual([]);
      expect(expiry.recorded).toEqual([]);
      expect(expiry.errors[0]).toBeInstanceOf(ExecutionCancelledError);
    });

    test("AC8: app.cancel after the decision is recorded, before the run continues: the decided path never runs", async ({
      app,
      clock,
    }) => {
      await execute(app, ShortExpiryWorkflowStart, { orderId: "o-1" }, { threadId: THREAD });
      expiry.behavior = decide;
      let started: { result: Promise<CancelOutput> } | undefined;
      // the resume's observer is told after the expiry is recorded and before the pass starts
      expiry.onResume = async () => {
        started ??= await cancelUnderWay(app);
      };
      await clock.advance(hours(4));
      await until(() => started !== undefined);

      await expect(started?.result).resolves.toEqual({ cancelled: true });
      expect(expiry.recorded).toEqual([]);
      expect(expiry.ended).toEqual([]);
      expect(expiry.errors[0]).toBeInstanceOf(ExecutionCancelledError);
    });
  });
});
