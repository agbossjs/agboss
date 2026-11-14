import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #928 AC2 — scenarios 22a and 22b — the store never answers the charge's fenced write (held for
 * ever, before it and after it committed): the holder stops at the end of its trust and hands over,
 * the next holder charges once (`Ran`) or replays the row; the late write is fenced. On SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s22a-charge-never-answers", "s22b-charge-committed-never-answered"],
});
