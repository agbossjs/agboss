import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1017 AC1 — scenario 23 — the charge's COMMIT applied and its answer lost as a transport error
 * (SQLite pods have no network: the held store loses the answer; the TCP sets cut the connection
 * with `DatabaseProxy.dropAfter`): the holder hands over — no undo, no failed record — and the
 * next holder replays the row, one charge.
 */
faultSuite({
  ...sqliteFaultTarget(),
  // 23b is for a set that declares `resolvesCommitByRetry`: it is skipped here (`resolving-commit.test.ts`)
  // 23c needs a TCP link (a PostgreSQL ErrorResponse in place of the COMMIT's answer): skipped here,
  // its skip is `commit-answer-skips.test.ts`; the postgres store's fault run delivers it
  scenarios: [
    "s23-commit-answer-reset",
    "s23b-commit-answer-reset-persists",
    "s23c-commit-answer-protocol-error",
  ],
});
