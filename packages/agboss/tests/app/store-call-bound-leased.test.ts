/**
 * #928 AC1 — the leased bound, in memory: a call under a held lease that never answers ends at the
 * lease's loss or at the trust's end (fixed at its start), never by the bound of an unleased call;
 * a call that hangs with its lease ends at the loss.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
  StoreOutcomeSource,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { reportHeldOperations } from "../../src/testing/faults/held-stores.js";
import { OperationPhase } from "../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { passLive } from "../helpers/live-time.js";
import { until } from "../helpers/until.js";
import { kill, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import {
  SlotWorkflowStart,
  StoreBoundLeasedApplication,
  slots,
} from "./fixtures/store-bound-leased.application.js";
import { causeOf, isGivingBack, settledFlag } from "./fixtures/store-bound-helpers.js";

const one = testWith(StoreBoundLeasedApplication);

const operations: string[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  resetLogged();
  slots.hung = false;
  slots.asked = 0;
  operations.length = 0;
  stop = reportHeldOperations({
    onOperation: (event) => {
      if (event.phase === OperationPhase.Invoke) operations.push(event.operation);
    },
  });
});

afterEach(() => {
  stop();
  processHoldPoints.releaseAll();
});

describe("#928 AC1: the bound of a call under a lease", () => {
  one(
    "AC1: a call whose lease is lost while it hangs rejects at the loss, not at the trust's end",
    async ({ app, clock }) => {
      await app.ready();
      slots.hung = true;
      const call = rejectionOf(execute(app, SlotWorkflowStart, { text: "key-1" }));
      const isSettled = settledFlag(call);
      await until(() => slots.asked === 1, "the slot is asked");
      const startedAt = clock.now().getTime();
      // the store no longer renews this holder: its next renewal says the lease is over
      kill("instance-1");

      await passLive(clock, seconds(10));
      await until(isSettled, "the call ended at the renewal that found the lease lost");

      const error = await call;
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      // the lease's own loss, not the bound's hand-over
      expect(causeOf(error)).not.toBeInstanceOf(StoreCallTimeoutError);
      expect(clock.now().getTime() - startedAt).toBeLessThan(seconds(29));
      expect(logged.filter((entry) => entry.code === "store.call-timeout")).toEqual([]);
    },
  );

  one(
    "AC1: the bound is fixed at the call's start: a renewal meanwhile does not extend it",
    async ({ app, clock }) => {
      await app.ready();
      slots.hung = true;
      const call = rejectionOf(execute(app, SlotWorkflowStart, { text: "key-2" }));
      const isSettled = settledFlag(call);
      await until(() => slots.asked === 1, "the slot is asked");

      // two confirmed renewals move the trust to 39 s: the call's bound stays at its start's 29 s
      await passLive(clock, seconds(28));
      expect(isSettled()).toBe(false);
      await passLive(clock, seconds(2));
      await until(isSettled, "the call handed over at its own bound");

      const cause = causeOf(await call);
      expect(cause).toBeInstanceOf(StoreCallTimeoutError);
      if (!(cause instanceof StoreCallTimeoutError)) throw new Error("not a timeout");
      expect(cause.timeout).toBeGreaterThan(seconds(28));
      expect(cause.timeout).toBeLessThanOrEqual(seconds(29));
    },
  );

  one(
    "AC1: a rate-limit slot held in a step hands over; the log and the counter say it",
    async ({ app, clock }) => {
      await app.ready();
      slots.hung = true;
      const call = rejectionOf(execute(app, SlotWorkflowStart, { text: "key-3" }));
      await until(() => slots.asked === 1, "the slot is asked");

      await passLive(clock, seconds(40));
      const error = await call;

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(causeOf(error)).toMatchObject({
        store: "HungSlotRepository",
        operation: "acquire",
        source: StoreOutcomeSource.Framework,
      });
      // abandoned, never released
      expect(operations.filter(isGivingBack)).toEqual([]);
      const timeouts = logged.filter((entry) => entry.code === "store.call-timeout");
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toMatchObject({ level: "warn" });
      expect(timeouts[0]?.message).toContain("HungSlotRepository.acquire");
    },
  );
});
