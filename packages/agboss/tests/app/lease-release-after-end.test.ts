/**
 * #928 (coordinator decision, a defect) — once a tree's terminal record is durable, a lease release
 * that hangs or fails does not change what the caller gets: the real result, the failure logged, the
 * lease left to expire. Otherwise a client without an idempotency key retries a run that charged.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import { testWith } from "../../src/testing/index.js";
import { HoldPhase, processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { ChargeWorkflowStart, book, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { settledFlag } from "./fixtures/store-bound-helpers.js";
import { StoreBoundLeasedApplication } from "./fixtures/store-bound-leased.application.js";

const one = testWith(StoreBoundLeasedApplication);

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  resetLogged();
});

afterEach(() => {
  processHoldPoints.releaseAll();
});

const releaseFailures = () =>
  logged.filter((entry) => entry.code === "execution.lease-release-failed");

describe("#928: a release after the terminal record does not change the result", () => {
  one(
    "a release that hangs: the caller gets the receipt within the bound, one charge, the failure logged",
    async ({ app, clock }) => {
      await app.ready();
      processHoldPoints.arm({ point: StoreHoldPoint.LeaseRelease });
      const call = execute(app, ChargeWorkflowStart, { text: "order-r1" });
      const isSettled = settledFlag(call);
      await until(
        () =>
          processHoldPoints.held.some(
            (held) => held.point === StoreHoldPoint.LeaseRelease.toString(),
          ),
        "the release is held",
      );
      expect(isSettled()).toBe(false);

      await passLive(clock, STORE_CALL_BOUND);
      const outcome = await call;

      expect(outcome.output).toEqual({ chargeId: "charge-order-r1-1" });
      expect(book.charges).toHaveLength(1);
      expect(releaseFailures()).toHaveLength(1);
      expect(releaseFailures()[0]?.level).toBe("warn");
    },
  );

  one(
    "a release that fails (its answer lost): the caller gets the receipt, one charge, the failure logged",
    async ({ app }) => {
      await app.ready();
      processHoldPoints.arm({
        point: StoreHoldPoint.LeaseRelease,
        phase: HoldPhase.After,
        loseAnswer: true,
      });

      const outcome = await execute(app, ChargeWorkflowStart, { text: "order-r2" });

      expect(outcome.output).toEqual({ chargeId: "charge-order-r2-1" });
      expect(book.charges).toHaveLength(1);
      expect(releaseFailures()).toHaveLength(1);
    },
  );
});
