import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/** #484 AC1, AC4 — scenario 5 — SIGSTOP → SIGCONT: the zombie's write refused, in both orders, at the payment's intent (5c, #584) and between the intent and its send (5d, #608), on SQLite pods (one file, several processes). */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: [
    "s05-zombie-write-refused",
    "s05b-zombie-reaches-charge-first",
    "s05c-zombie-reaches-payment-first",
    "s05d-zombie-recorded-not-sent",
  ],
});
