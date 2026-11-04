import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #720 — scenario 16 — a pod's claims of a child answered by the store but never heard, twice: the
 * lease its reclaim kept goes back, the child still runs once and the batch ends; on SQLite pods
 * (one file, several processes).
 */
faultSuite({ ...sqliteFaultTarget(), scenarios: ["s16-claim-answer-lost"] });
