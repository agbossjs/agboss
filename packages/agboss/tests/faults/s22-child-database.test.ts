import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #928 AC2 — scenarios 22f and 22g — a child's claim answered and never heard (the #720 path), and
 * a database frozen as the charge goes to write: the holder ends within its bound and hands over,
 * the next holder charges once. On SQLite pods (the held stores' outage hangs).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s22f-child-claim-never-answered", "s22g-database-frozen-mid-charge"],
});
