import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1132 AC3 — scenario 25 — a pod killed (kill -9) in the middle of `app.cancel` of a resting tree:
 * right after the paused run was removed (the sweep of another pod ends the order cancelled and closes
 * its pause), and right after the cancel became durable (a second cancel on another pod ends it and
 * answers `true`). On SQLite pods.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s25-cancel-resting-kill-after-drop", "s25b-cancel-resting-kill-after-request"],
});
