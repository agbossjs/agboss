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
 *   the lease — one owner per tree is broken.
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
import { sqliteFaultTarget } from "./sqlite-target.js";

const unfenced = sqliteFaultTarget(
  fileURLToPath(new URL("./unfenced.fault-stores.ts", import.meta.url)),
);
const unfencedCalls = sqliteFaultTarget(
  fileURLToPath(new URL("./unfenced-calls.fault-stores.ts", import.meta.url)),
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
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /fencedEffect\.write .* at token 1 .* was accepted after epoch 2 was granted/u,
      ),
    );
  }, 120_000);

  it("a finish that is a plain release: 6b fails finished-work-untouched — the finished child's lease granted again", async () => {
    const failure = await failureOf(s06FinishedChild, releasing);
    expect(failure.invariants).toContain(FaultInvariant.FinishedWorkUntouched);
  }, 120_000);

  it("no fencing check on the payment's intent: 5c fails one-owner — the zombie's stale intent accepted", async () => {
    const failure = await failureOf(s05ZombiePaysFirst, unfencedCalls);
    expect(failure.invariants).toContain(FaultInvariant.OneOwner);
    expect(failure.violations.map((found) => found.message)).toContainEqual(
      expect.stringMatching(
        /outboundCall\.saveIfAbsent .* at token 1 .* was accepted after epoch 2 was granted/u,
      ),
    );
  }, 120_000);
});
