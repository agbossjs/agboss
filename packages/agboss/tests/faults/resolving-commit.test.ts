import { fileURLToPath } from "node:url";
import { faultSuite } from "../../src/testing/faults/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1017 — a store set that declares `resolvesCommitByRetry` (MongoDB's commit is retried and its
 * real outcome learned): 23b — the retry's answer lost too — is its unknown outcome. SQLite has no
 * TCP link to cut, so 23b and its sabotage skip on this set (not-run, not failed) — the declaration
 * reaches the scenarios, which is all this file shows; on the core's own set 23 runs as before
 * (`s23-commit-answer-reset.test.ts`) and 23b skips (the set declares nothing).
 */
faultSuite({
  ...sqliteFaultTarget(fileURLToPath(new URL("./resolving.fault-stores.ts", import.meta.url))),
  scenarios: [
    "s23b-commit-answer-reset-persists",
    "s23b-sabotage-reset-as-definite",
    "s23c-commit-answer-protocol-error",
  ],
});
