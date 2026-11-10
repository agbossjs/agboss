import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #811 AC4 — scenario 17 — a pod frozen between an A2A task's accept and its execution's running
 * record, before its start (17) and after keeping the task's id (17b): another pod's read repair
 * settles the task FAILED start-lost, and the thawed starter runs nothing; on SQLite pods (one
 * file, several processes).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: ["s17-a2a-accept-crash", "s17b-a2a-id-kept-crash"],
});
