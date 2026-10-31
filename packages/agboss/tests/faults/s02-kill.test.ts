import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/** #484 AC1, AC4 — scenario 2 — SIGKILL mid-step, on SQLite pods (one file, several processes). */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s02-sigkill-mid-step"],
});
