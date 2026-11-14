import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1017 AC1 — scenario 23 — the charge's COMMIT applied and its answer lost as a transport error
 * (SQLite pods have no network: the held store loses the answer; the TCP sets cut the connection
 * with `DatabaseProxy.dropAfter`): the holder hands over — no undo, no failed record — and the
 * next holder replays the row, one charge.
 */
faultSuite({ ...sqliteFaultTarget(), scenarios: ["s23-commit-answer-reset"] });
