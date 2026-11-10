import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #811 AC4 — scenario 18 — an A2A task at INPUT_REQUIRED, a follow-up's resume on one pod racing a
 * CancelTask on another, forced in both orders (18: the resume takes the pause and its pass runs to
 * the charge; 18b: the cancel withdraws the pause first; 18c: the resume takes the pause, its pass
 * not begun): never both resumed with effects and canceled; on SQLite pods (one file, several
 * processes).
 */
faultSuite({
  ...sqliteFaultTarget(),
  scenarios: [
    "s18-a2a-resume-vs-cancel",
    "s18b-a2a-cancel-vs-resume",
    "s18c-a2a-resumed-cancel-before-pass",
  ],
});
