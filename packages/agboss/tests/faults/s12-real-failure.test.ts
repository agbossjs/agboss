import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #484 AC1, AC4 — scenario 12 — compensation only on a real failure, and 12b (#607) — an undo
 * marked done is never run again; on SQLite pods (one file, several processes).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s12-real-failure-undone-once", "s12b-marked-undo-not-again"],
});
