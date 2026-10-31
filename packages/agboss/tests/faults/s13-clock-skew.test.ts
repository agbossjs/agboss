import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/** #533 AC4 — scenarios 13 — pods whose clocks are ten leases off, on SQLite pods (one file, several processes). */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s13-clock-ahead", "s13-clock-behind"],
});
