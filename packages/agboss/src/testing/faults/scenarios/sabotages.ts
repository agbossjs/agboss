import { FaultInvariant } from "../invariants/violations.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { s14EveryErrorDefinite, s15TrustedAsLookup } from "./s14-s15-key-expiry.js";

/**
 * Scenarios that must fail on any store set (#657, #658): the fixture's payment integration broken
 * on purpose — every gateway error taken for a definite failure, a key's replay trusted as a lookup
 * — each charges twice, so `effects-once` fails. `faultSuite` runs them by default (#831): each
 * case passes only when its invariant fails with its evidence — the suite bites on the set's
 * database too.
 */

/** A sabotage: the scenario, the invariant it must break and the violation that shows it. */
export interface FaultSabotage extends RunnableFaultScenario {
  readonly violates: FaultInvariant;
  /** What one of the violations says. */
  readonly evidence: RegExp;
}

/** A second payment of one order: what both sabotages cause. */
const PAID_TWICE = /was paid 2 times at the gateway/u;

/** Every sabotage, in the suite's order. */
export const SABOTAGES: readonly FaultSabotage[] = [
  { ...s14EveryErrorDefinite, violates: FaultInvariant.EffectsOnce, evidence: PAID_TWICE },
  { ...s15TrustedAsLookup, violates: FaultInvariant.EffectsOnce, evidence: PAID_TWICE },
];
