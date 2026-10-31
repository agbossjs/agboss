import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/** #484 AC1, AC4 — scenario 9 — a crash after sending, before the answer, on SQLite pods (one file, several processes). */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s09-crash-after-send"],
});
