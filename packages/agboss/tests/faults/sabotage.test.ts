/**
 * #484 AC4 — the scenarios bite: each runs on a deliberately broken store set and fails on the
 * invariant the store breaks (a permanent negative test; the same scenarios pass on the real set,
 * s05-zombie.test.ts and s06-children.test.ts).
 *
 * - no fencing check on the business write (`UnfencedSqliteFencedEffectRepository`): scenario 5b's
 *   zombie writes the charge at its stale token after the new holder was granted the lease — one
 *   owner per tree is broken;
 * - a `finish` that is a plain `release` (`ReleasingSqliteExecutionLeaseRepository`, #520):
 *   scenario 6b's frozen pod is granted the finished child's lease — finished work is touched;
 * - no fencing check on the payment's intent (`UnfencedSqliteOutboundCallRepository`, #584):
 *   scenario 5c's zombie records its payment at its stale token after the new holder was granted
 *   the lease — one owner per tree is broken;
 * - a lease renewal that says yes to a lease that is over (`StaleRenewingSqliteExecutionLeaseRepository`,
 *   #608): scenario 5d's zombie, frozen between its payment's intent and its send, passes its
 *   `confirmNow()` after the new holder paid and sends the payment a second time;
 * - a tree store that forgets every undo's done mark (`ForgetfulSqliteExecutionTreeRepository`,
 *   #607): scenario 12b's next pod releases the reservation the frozen one released and marked.
 *
 * #533 item 5: every run's store history also fails the linearizability checker (`linearizable`).
 *
 * #657, #658 — the payment's own integration broken, on the real store set: every gateway error
 * taken for a definite failure (as before #657), scenario 14's lost answer is resent after the
 * gateway forgot its key; no key retention declared (#658), scenario 15's replay of an expired key
 * is a new charge — each fails effects-once with a second payment.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FaultInvariant,
  FaultInvariantError,
  runFaultScenario,
  type FaultScenario,
} from "../../src/testing/faults/index.js";
import {
  s05ZombieFirst,
  s05ZombiePaysFirst,
} from "../../src/testing/faults/scenarios/s05-zombie.js";
import { s06FinishedChild } from "../../src/testing/faults/scenarios/s06-children.js";
import { s05ZombieRecordedNotSent } from "../../src/testing/faults/scenarios/s05d-recorded-not-sent.js";
import { s12bMarkedUndo } from "../../src/testing/faults/scenarios/s12b-marked-undo.js";
import {
  s14EveryErrorDefinite,
  s15Undeclared,
} from "../../src/testing/faults/scenarios/s14-s15-key-expiry.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

const unfenced = sqliteFaultTarget(
  fileURLToPath(new URL("./unfenced.fault-stores.ts", import.meta.url)),
);
const unfencedCalls = sqliteFaultTarget(
  fileURLToPath(new URL("./unfenced-calls.fault-stores.ts", import.meta.url)),
);
const staleRenewing = sqliteFaultTarget(
  fileURLToPath(new URL("./stale-renewing.fault-stores.ts", import.meta.url)),
);
const forgetful = sqliteFaultTarget(
  fileURLToPath(new URL("./forgetful-marks.fault-stores.ts", import.meta.url)),
);
const releasing = sqliteFaultTarget(
  fileURLToPath(new URL("./releasing-finish.fault-stores.ts", import.meta.url)),
);

/** What `scenario` failed with on `target`; the test fails when it passed. */
async function failureOf(
  scenario: FaultScenario,
  target: typeof unfenced,
): Promise<FaultInvariantError> {
  const error: unknown = await runFaultScenario(scenario, target).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(FaultInvariantError);
  return error as FaultInvariantError;
}

describe("#484 AC4: a broken store fails the scenario that targets it", () => {
  it("no fencing check on the business write: 5b fails one-owner — the zombie's stale write accepted", async () => {
    const failure = await failureOf(s05ZombieFirst, unfenced);
    expect(failure.invariants).toContain(FaultInvariant.OneOwner);
    // #533 item 5: the recorded history has no order the sequential model explains
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /fencedEffect\.write .* at token 1 .* was accepted after epoch 2 was granted/u,
      ),
    );
  }, 120_000);

  it("a finish that is a plain release: 6b fails finished-work-untouched — the finished child's lease granted again", async () => {
    const failure = await failureOf(s06FinishedChild, releasing);
    expect(failure.invariants).toContain(FaultInvariant.FinishedWorkUntouched);
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
  }, 120_000);

  it("no fencing check on the payment's intent: 5c fails one-owner — the zombie's stale intent accepted", async () => {
    const failure = await failureOf(s05ZombiePaysFirst, unfencedCalls);
    expect(failure.invariants).toContain(FaultInvariant.OneOwner);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /outboundCall\.saveIfAbsent .* at token 1 .* was accepted after epoch 2 was granted/u,
      ),
    );
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
  }, 120_000);

  it("a renewal that says yes to a lease that is over: 5d's zombie sends the payment again — it fails effects-once", async () => {
    const failure = await failureOf(s05ZombieRecordedNotSent, staleRenewing);
    expect(failure.invariants).toContain(FaultInvariant.EffectsOnce);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(/o-5d reached the gateway 2 times \(from b, a\)/u),
    );
    // the stale renewal accepted after epoch 2 was granted: no sequential order explains it
    expect(failure.invariants).toContain(FaultInvariant.Linearizable);
  }, 120_000);

  it("a tree store that forgets an undo's done mark: 12b's next pod releases again — it fails no-undo-on-hand-over", async () => {
    const failure = await failureOf(s12bMarkedUndo, forgetful);
    expect(failure.invariants).toContain(FaultInvariant.NoUndoOnHandOver);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /o-12b declined, and its reservation was released 2 times \(on a, b\)/u,
      ),
    );
  }, 120_000);

  it("#657 AC2: every gateway error taken for a definite failure: 14's lost answer is resent past the key — two payments", async () => {
    const failure = await failureOf(s14EveryErrorDefinite, sqliteFaultTarget());
    expect(failure.invariants).toContain(FaultInvariant.EffectsOnce);
    expect(failure.violations.map((found) => found.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/o-14 reached the gateway 2 times \(from a, b\)/u),
        "o-14 was paid 2 times at the gateway",
      ]),
    );
  }, 120_000);

  it("#658: no key retention declared: 15's replay of an expired key is a new charge — two payments", async () => {
    const failure = await failureOf(s15Undeclared, sqliteFaultTarget());
    expect(failure.invariants).toContain(FaultInvariant.EffectsOnce);
    expect(failure.violations.map((found) => found.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/o-15 reached the gateway 2 times \(from a, b\)/u),
        "o-15 was paid 2 times at the gateway",
      ]),
    );
  }, 120_000);
});
