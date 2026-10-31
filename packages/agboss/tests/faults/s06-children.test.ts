import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/** #484 AC1, AC4 — scenario 6 — scale-down with children active; finished work not taken, on SQLite pods (one file, several processes). */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s06-scale-down-children", "s06b-finished-child-not-taken"],
});
