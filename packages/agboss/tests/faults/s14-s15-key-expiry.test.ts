import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #657, #658 — scenarios 14 and 15 — the gateway's key expires before the call is settled: an
 * answer lost after the charge is reconciled, never resent (14); a replay-only gateway's key past
 * the declared retention is never replayed (15); on SQLite pods (one file, several processes).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s14-ambiguous-answer-reconciled", "s15-key-expired-not-resent"],
});
