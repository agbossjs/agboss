import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultInvariant, FaultInvariantError, faultSuite } from "../../src/testing/faults/index.js";
import { runFaultScenario } from "../../src/testing/faults/scenario.js";
import { s21Claimed, s21cCommitted } from "../../src/testing/faults/scenarios/s21-pause-notices.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #940 AC3 — scenario 21 — a pod killed around a pause's notice: holding the claim of it, after
 * delivering it and before the ack, right after the close committed; on SQLite pods. The listener
 * is told at least once, never zero times, under one `deliveryId` per notice (`notices-once-each-in-order`).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: [
    "s21-pause-notice-kill-after-claim",
    "s21b-pause-notice-kill-after-delivery",
    "s21c-pause-notice-kill-after-resolve",
  ],
});

/**
 * #940 AC3 — the notice scenarios bite: a pause store that writes an answer's notice outside the
 * answer's transaction loses it when the pod is killed in between (21c), one that acknowledges a
 * notice when it claims it loses it when the pod is killed after its claim (21) — each fails
 * `notices-once-each-in-order`: the pause was never told `closed`.
 */
const SABOTAGES = [
  {
    scenario: s21Claimed,
    store: "a pause store that acknowledges a notice before it was delivered",
    module: "acked-first",
  },
  {
    scenario: s21cCommitted,
    store: "a pause store that writes the notice outside the close's transaction",
    module: "outside-close",
  },
] as const;

describe("#940 AC3: the notice scenarios fail on a sabotage store", () => {
  it.each(
    SABOTAGES.map(
      (sabotage) => [`${sabotage.scenario.id} on ${sabotage.store}`, sabotage] as const,
    ),
  )(
    "%s: the pause is never told closed",
    async (_name, { scenario, module }) => {
      const target = sqliteFaultTarget(
        fileURLToPath(new URL(`./${module}.fault-stores.ts`, import.meta.url)),
      );

      const failure: unknown = await runFaultScenario(scenario, target).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(FaultInvariantError);
      const { violations } = failure as FaultInvariantError;
      expect(violations.map((one) => one.invariant)).toContain(
        FaultInvariant.NoticesOnceEachInOrder,
      );
      expect(violations.map((one) => one.message)).toContainEqual(
        expect.stringMatching(/was never told closed/u),
      );
    },
    120_000,
  );
});
