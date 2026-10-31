import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/** #484 AC1, AC4 — scenario 10 — one order, two executions, on SQLite pods (one file, several processes). */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s10-one-order-two-executions"],
});
