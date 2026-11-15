import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #946 AC2 — scenario 28 — a pod killed (kill -9) between the reassignment of a pause and the new
 * message: the store's transaction is durable (the old pause `Reassigned`, the replacement unsent),
 * the channel was sent nothing; another pod's timers send the replacement once, naming the pause it
 * replaces and its assignee; the old id answers nothing; the order is reserved, charged and paid
 * once. On SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s28-pause-reassign-kill-before-send"],
});
