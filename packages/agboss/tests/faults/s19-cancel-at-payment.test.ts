import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #909 AC3 — scenario 19 — a live holder between its task's cancel request and its next lease
 * renewal reaches a fenced write: the charge's (19) or the payment's intent (19b). The store
 * refuses it in the lease's transaction: no charge, no gateway request after the cancel, the tree
 * unwinds as cancelled, its reservation undone once. On SQLite pods (one file, several processes).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s19-cancel-at-charge", "s19b-cancel-at-payment"],
});
