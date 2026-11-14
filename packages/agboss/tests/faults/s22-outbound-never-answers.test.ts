import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #928 AC2 — scenarios 22c, 22d and 22e — the store never answers a write of the payment's
 * outbound call (the answer, the intent, a definite failure's record): one charge, the next holder
 * reconciles the pending row or replays the completed one before any resend. On SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: [
    "s22c-payment-answer-never-recorded",
    "s22c2-payment-answer-recorded-never-answered",
    "s22d-intent-never-answered",
    "s22d2-intent-recorded-never-answered",
    "s22e-failure-never-recorded",
  ],
});
