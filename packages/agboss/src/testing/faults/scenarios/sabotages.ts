import type { FaultScenario } from "../scenario.js";
import { s14EveryErrorDefinite, s15Undeclared } from "./s14-s15-key-expiry.js";

/**
 * Scenarios that must fail on any store set (#657, #658): the fixture's payment integration broken
 * on purpose — every gateway error taken for a definite failure, no key retention declared — each
 * charges twice, so `effects-once` fails. A store's own suite runs them with `runFaultScenario` to
 * show the fault suite bites on its database too; never part of `faultSuite`.
 */
export const FAULT_SABOTAGE_SCENARIOS: readonly FaultScenario[] = [
  s14EveryErrorDefinite,
  s15Undeclared,
];
