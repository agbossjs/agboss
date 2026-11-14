/**
 * #928 AC1/AC2 — a store call that never answers is bounded: under a lease it hands the tree over
 * at the trust's end (nothing released, the next holder reconciles), anywhere else it is a store
 * error at 15 s.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  StoreCallTimeoutError,
  StoreOutcomeSource,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { HoldPhase, processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { reportHeldOperations } from "../../src/testing/faults/held-stores.js";
import { OperationPhase } from "../../src/testing/faults/operation-history.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { passLive } from "../helpers/live-time.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { ChargeWorkflowStart, book, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { StoreBoundApplication } from "./fixtures/store-bound.application.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";

const two = testWith(StoreBoundApplication, { instances: 2 });

const operations: string[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  operations.length = 0;
  stop = reportHeldOperations({
    onOperation: (event) => {
      if (event.phase === OperationPhase.Invoke)
        operations.push(`${event.instanceId}:${event.operation}`);
    },
  });
});

afterEach(() => {
  stop();
  processHoldPoints.releaseAll();
});

describe("#928 AC1: a fenced write held for ever, in memory", () => {
  two(
    "AC1: at the trust's end it rejects ExecutionLeaseLostError (cause StoreCallTimeoutError, framework); no failed record, no release; another instance charges once",
    async ({ apps, clock }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      processHoldPoints.arm({ point: StoreHoldPoint.FencedEffectWrite });
      const call = execute(a, ChargeWorkflowStart, { text: "order-9" });
      const failure = rejectionOf(call);
      await until(() => processHoldPoints.held.length === 1, "the write is held");

      await passLive(clock, seconds(40));
      const error = await failure;

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      const cause = (error as ExecutionLeaseLostError).cause;
      expect(cause).toBeInstanceOf(StoreCallTimeoutError);
      expect(cause).toMatchObject({ source: StoreOutcomeSource.Framework, operation: "runOnce" });
      expect(recovery.errors).toEqual([]);
      // abandoned, never released: the lease expires in the store
      expect(operations.filter((op) => /lease\.(release|retire)/u.test(op))).toEqual([]);

      await passLive(clock, seconds(60));
      const [end] = await ends(1);
      expect(end?.output).toEqual({ chargeId: "charge-order-9-2" });
      expect(book.charges).toHaveLength(1);
    },
  );
});
