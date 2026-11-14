import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #811 AC4 — scenario 17 — a pod frozen between an A2A task's accept and its execution's running
 * record, before its start (17) and after keeping the task's id (17b): another pod's read repair
 * settles the task FAILED start-lost, and the thawed starter runs nothing; on SQLite pods (one
 * file, several processes).
 *
 * #1059 — the same under the store-call bound (17, 17b bounded: the frozen pod keeps it), and what a
 * hung claim (17c) and a hung accept (17d) end in on a pod that is not frozen.
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: [
    "s17-a2a-accept-crash",
    "s17b-a2a-id-kept-crash",
    "s17-a2a-accept-crash-bounded",
    "s17b-a2a-id-kept-crash-bounded",
    "s17c-a2a-claim-never-answers",
    "s17d-a2a-accept-never-answers",
  ],
});
