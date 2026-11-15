import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1090 — scenarios 26a and 26b: a holder's checkpoint write never answers after a task's writes
 * were saved, the holder is killed; the next holder applies the saved writes and runs the rest,
 * once. On SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s26a-writes-saved-before-charge", "s26b-writes-saved-after-charge"],
});
