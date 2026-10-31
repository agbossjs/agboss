import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/** #484 AC1, AC4 — scenario 1 — SIGTERM: a drain, and a step that outlasts the shutdown timeout, on SQLite pods (one file, several processes). */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s01-sigterm-drains", "s01b-sigterm-shorter-than-step"],
});
