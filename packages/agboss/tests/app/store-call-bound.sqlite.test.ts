/**
 * #928 AC1 on SQLite — the SQLite stores under `withHoldPoints` and `StoreOutageMode.Hang`: a fenced
 * write, an outbound mark and the sweep's look end within their bound (a store that is local and
 * synchronous is bounded too, where a test's hold or a stalled file keeps a call); a synchronous
 * return is not wrapped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChildExecutionQueueRepository,
  ExecutionLeaseLostError,
  OutboundCallRepository,
  StoreCallTimeoutError,
  StoreOutcomeSource,
} from "../../src/index.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { StoreBounds } from "../../src/app/store-bounds.js";
import { boundedStoreOf } from "../../src/app/store-call-bound.js";
import { heldStoreState } from "../../src/testing/faults/held-stores.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { StoreOutageMode } from "../../src/testing/faults/store-outage.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { resetRecovery, seen as recovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { SqliteChargeWorkflowStart } from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import { StoreBoundSqliteApplication } from "../infrastructure/sqlite/fixtures/store-bound-sqlite.application.js";

sqliteFilePerTest();
const test = testWith(StoreBoundSqliteApplication);

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
});

afterEach(() => {
  processHoldPoints.releaseAll();
  heldStoreState.outage.end();
});

const key = effectKeyForTesting({
  scopeKey: "default:root-1",
  tenantId: "default",
  leaseExecutionId: "root-1",
  token: 1,
  idempotencyKey: "step-1",
  name: "payment",
});

describe("#928 AC1: the SQLite stores are bounded", () => {
  test("a fenced write held for ever hands over at the trust's end (SQLite)", async ({
    app,
    clock,
  }) => {
    processHoldPoints.arm({ point: StoreHoldPoint.FencedEffectWrite });
    const failure = rejectionOf(execute(app, SqliteChargeWorkflowStart, { text: "order-3" }));
    await until(() => processHoldPoints.held.length === 1, "the write is held");

    await passLive(clock, seconds(40));
    const error = await failure;

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(error).toMatchObject({ cause: expect.any(StoreCallTimeoutError) });
    expect(recovery.errors).toEqual([]);
  });

  test("an outbound mark and the sweep's look under StoreOutageMode.Hang fail at 15 s", async ({
    app,
    clock,
  }) => {
    await app.ready();
    heldStoreState.outage.begin(StoreOutageMode.Hang);
    const marking = rejectionOf(app.resolve(OutboundCallRepository).markCompleted(key, "a", "{}"));
    const claiming = rejectionOf(
      app.resolve(ChildExecutionQueueRepository).claimFirstByStatusQueuedOrderByDepthDesc(),
    );

    await clock.advance(seconds(15));

    for (const error of [await marking, await claiming]) {
      expect(error).toBeInstanceOf(StoreCallTimeoutError);
      expect(error).toMatchObject({ source: StoreOutcomeSource.Framework, timeout: seconds(15) });
    }
  });
});

describe("#928: a synchronous return is not wrapped", () => {
  it("what a method returns without a promise is returned as it is", () => {
    const store = { size: (): number => 3, rows: (): readonly number[] => [1, 2] };
    const bounded = boundedStoreOf(
      OutboundCallRepository,
      store,
      new StoreBounds(new VirtualClock()),
    );

    expect(bounded.size()).toBe(3);
    expect(bounded.rows()).toEqual([1, 2]);
  });
});
