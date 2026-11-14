/**
 * #928 AC1 sabotage S1 — what the bound is worth: with `BOUNDED_CONTRACTS` emptied (the test seam)
 * a fenced write held for ever, deaf to its step's signal as a silent peer is, never settles; a
 * hold that listens to the signal is freed by the lease's expiry alone — which is why the holds of
 * the tests are deaf.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { BOUNDED_CONTRACTS } from "../../src/infrastructure/contracts.js";
import { testWith } from "../../src/testing/index.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { logged, resetLogged } from "../helpers/log.js";
import { until } from "../helpers/until.js";
import { ends, kill, levers, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { ChargeWorkflowStart, book, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { rejectionOf } from "./fixtures/fence-takeover.js";
import { settledFlag } from "./fixtures/store-bound-helpers.js";
import { StoreBoundApplication } from "./fixtures/store-bound.application.js";
import {
  listening,
  StoreBoundListeningApplication,
} from "./fixtures/store-bound-listening.application.js";

const deaf = testWith(StoreBoundApplication);
const listens = testWith(StoreBoundListeningApplication);

const contracts = [...BOUNDED_CONTRACTS];

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  resetLogged();
  listening.hangs = false;
  listening.asked = 0;
  // the sabotage: no store is bounded
  BOUNDED_CONTRACTS.clear();
});

afterEach(() => {
  processHoldPoints.releaseAll();
  for (const contract of contracts) BOUNDED_CONTRACTS.add(contract);
});

describe("#928 AC1 sabotage S1: the bound is what ends a hung call", () => {
  deaf(
    "S1: with BOUNDED_CONTRACTS emptied the held fenced write does not settle within 60 s of virtual time",
    async ({ app, clock }) => {
      await app.ready();
      processHoldPoints.arm({ point: StoreHoldPoint.FencedEffectWrite });
      const call = rejectionOf(execute(app, ChargeWorkflowStart, { text: "order-s1" }));
      const isSettled = settledFlag(call);
      await until(() => processHoldPoints.held.length === 1, "the write is held");

      await passLive(clock, seconds(60));

      expect(BOUNDED_CONTRACTS.size).toBe(0);
      expect(isSettled()).toBe(false);
      expect(logged.map((entry) => entry.code)).not.toContain("store.call-timeout");
    },
  );

  listens(
    "S1: with a hold that listens to the step's signal, the in-memory case passes without the proxy (why holds must be deaf)",
    async ({ app, clock }) => {
      await app.ready();
      listening.hangs = true;
      const call = execute(app, ChargeWorkflowStart, { text: "order-s1b" });
      call.catch(() => undefined);
      await until(() => listening.asked === 1, "the write is asked");

      // the store stops renewing it: the lease's loss aborts its signal and frees the hold
      kill("instance-1");
      await passLive(clock, seconds(10));
      await until(() => book.runs.length === 1, "the write ended with the step's stop");
      expect(book.runs).toEqual([{ token: 1, status: "refused" }]);
      // the next holder (the sweep) charges once, the peer being well again
      listening.hangs = false;
      levers.dead.delete("instance-1");
      await passLive(clock, seconds(70));
      const [end] = await ends(1);

      expect(end?.output).toEqual({ chargeId: "charge-order-s1b-2" });
      expect(book.charges).toHaveLength(1);
      expect(logged.map((entry) => entry.code)).not.toContain("store.call-timeout");
    },
  );
});
