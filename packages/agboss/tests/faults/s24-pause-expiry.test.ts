import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultInvariant, FaultInvariantError, faultSuite } from "../../src/testing/faults/index.js";
import { runFaultScenario } from "../../src/testing/faults/scenario.js";
import {
  s24bAfterRecord,
  s24cZombie,
} from "../../src/testing/faults/scenarios/s24-pause-expiry.js";
import { s24dCancel } from "../../src/testing/faults/scenarios/s24d-pause-expiry-cancel.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #941 AC3 — scenario 24 — a pod killed around the expiry of a pause (kill -9): before the compare-
 * and-set that records it (the channel's handler asked again, one decision recorded), right after it
 * (the recovery continues with the closed pause), a pod frozen before it that wakes after another
 * expired the pause (its record is refused), and a cancel requested meanwhile (the order ends
 * cancelled, nothing charged or paid after it). On SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: [
    "s24-pause-expiry-kill-before-record",
    "s24b-pause-expiry-kill-after-record",
    "s24c-pause-expiry-zombie-refused",
    "s24d-pause-expiry-cancel",
    "s24e-pause-expiry-decided-once",
  ],
});

/**
 * #941 AC3 — the expiry scenarios bite: each runs on a deliberately broken store set and goes red
 * on what the store breaks — an expiry that is no compare-and-set closes the pause twice (24c); a
 * root whose `paused → running` mark is forgotten rests `paused` beside a closed pause (24b); a
 * cancel mark that never lands lets the expiry's decided order be charged after the cancel (24d).
 */
const SABOTAGES = [
  {
    scenario: s24cZombie,
    module: "outside-cas-expire",
    store: "a pause store whose expiry is no compare-and-set",
    invariant: FaultInvariant.OneExpiryDecision,
    message: /was closed 2 times/u,
  },
  {
    scenario: s24bAfterRecord,
    module: "forgetful-mark",
    store: "a record store that forgets the root's paused → running mark",
    invariant: FaultInvariant.NoPausedRootWithClosedPause,
    message: /was paused with a closed pause/u,
  },
  {
    scenario: s24dCancel,
    module: "unmarked-blind",
    store: "stores where a cancel lands nowhere (no mark, no request read back)",
    invariant: FaultInvariant.NoEffectAfterCancel,
    message: /after its cancel was durable/u,
  },
] as const;

describe("#941 AC3: the expiry scenarios fail on a sabotage store", () => {
  it.each(
    SABOTAGES.map(
      (sabotage) => [`${sabotage.scenario.id} on ${sabotage.store}`, sabotage] as const,
    ),
  )(
    "%s",
    async (_name, { scenario, module, invariant, message }) => {
      const target = sqliteFaultTarget(
        fileURLToPath(new URL(`./${module}.fault-stores.ts`, import.meta.url)),
      );

      const failure: unknown = await runFaultScenario(scenario, target).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(FaultInvariantError);
      const { violations } = failure as FaultInvariantError;
      expect(violations.map((one) => one.invariant)).toContain(invariant);
      expect(violations.map((one) => one.message)).toContainEqual(expect.stringMatching(message));
    },
    180_000,
  );
});
