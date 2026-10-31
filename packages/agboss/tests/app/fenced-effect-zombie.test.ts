/**
 * #500 AC2 — a zombie reaches the fenced effect: its lease stalled (`leases.stall`), the other
 * instance took it over under token 2. The zombie's call is refused (`ExecutionFencedError`) before
 * its key is looked up — nothing written, the new holder's receipt never returned — whether the new
 * holder wrote first or not yet. A hand-over (#471): no `.onError` side path, no failed record, no
 * `onExecutionError`; the zombie's call rejects with the fenced error itself.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionFencedError, FencedEffectStatus } from "../../src/index.js";
import { testWith, type TestLeases, type VirtualClock } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  book,
  ChargeWorkflowStart,
  FencedEffectApplication,
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import { passLive } from "../helpers/live-time.js";

const two = testWith(FencedEffectApplication, { instances: 2 });

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
});

afterEach(() => {
  letAllGo();
});

/** A's run is frozen before its effect and its lease stalled; the clock moves past B's sweep. */
async function stalledBeforeEffect(
  apps: readonly TestApp[],
  clock: VirtualClock,
  leases: TestLeases,
): Promise<{ readonly a: TestApp; readonly call: Promise<unknown> }> {
  const [a, b] = [instance(apps, 0), instance(apps, 1)];
  await a.ready();
  await b.ready();
  const call = execute(a, ChargeWorkflowStart, { text: "order-7" });
  call.catch(() => undefined);
  await frozenRuns(1);
  leases.stall(a);
  await clock.advance(seconds(31));
  // the new holder is live: its renewals reach the store in time (#534)
  await passLive(clock, seconds(31));
  return { a, call };
}

describe("#500 AC2: a zombie's effect is refused", () => {
  two(
    "AC2: a stalled holder's effect after takeover is refused, nothing written, no receipt",
    async ({ apps, clock, leases }) => {
      gates.before = 1;
      const { a, call } = await stalledBeforeEffect(apps, clock, leases);
      const [end] = await ends(1);
      expect(end?.output).toEqual({ chargeId: "charge-order-7-2" });

      // the zombie wakes inside its step, before its lease timers fire
      letAllGo();
      await settle();
      leases.resume(a);
      const error = await rejectionOf(call);

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(error).toMatchObject({ token: 1, observedToken: 2 });
      expect(book.charges).toEqual([{ order: "order-7", token: 2, chargeId: "charge-order-7-2" }]);
      expect(book.runs).toEqual([
        { token: 2, status: FencedEffectStatus.Ran },
        { token: 1, status: "refused" },
      ]);
      expect(recovery.ends).toHaveLength(1);
      expect(recovery.errors).toEqual([]);
    },
  );

  two(
    "AC2: refused even when the zombie arrives before the new holder writes",
    async ({ apps, clock, leases }) => {
      gates.before = 2;
      const { a, call } = await stalledBeforeEffect(apps, clock, leases);
      // B recovered the tree under token 2 and is frozen before its own effect
      await frozenRuns(2);
      const [zombie, holder] = gates.frozen.splice(0);

      zombie?.();
      await settle();
      leases.resume(a);
      const error = await rejectionOf(call);
      expect(book.charges).toEqual([]);
      holder?.();
      const [end] = await ends(1);

      expect(error).toBeInstanceOf(ExecutionFencedError);
      expect(error).toMatchObject({ token: 1, observedToken: 2 });
      expect(book.runs).toEqual([
        { token: 1, status: "refused" },
        { token: 2, status: FencedEffectStatus.Ran },
      ]);
      expect(end?.output).toEqual({ chargeId: "charge-order-7-2" });
      expect(book.charges).toHaveLength(1);
      expect(recovery.errors).toEqual([]);
    },
  );
});
