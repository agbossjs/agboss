// The `ledger-*` shards of #1366: the functions that write money — a spend into the ledger, a turn's cost, a
// retention's cut of the ledger — in files with other code (split from stryker-ranges.mjs for max-lines).
import { readFileSync } from "node:fs";
import { declarationsOf } from "./stryker-ranges-money.mjs";

const PACKAGE = new URL("../packages/agboss/", import.meta.url);

/**
 * The methods `names` (`#call`, `execute`) of the class in `file` as Stryker ranges, found by name: from the
 * method's line to its closing brace at the class's indent, so a method is mutated without the rest of the
 * class and a fixed range never moves with the code above.
 */
export function methodsOf(file, ...names) {
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  return names.map((name) => {
    const head = new RegExp(`^ {2}(?:(?:public|protected|private|static|async) )*${name}[(<]`);
    const start = lines.findIndex((line) => head.test(line));
    if (start < 0) throw new Error(`${file}: method ${name} not found`);
    const end = start + lines.slice(start).indexOf("  }");
    if (end < start) throw new Error(`${file}: the end of method ${name} not found`);
    return `${file}:${String(start + 1)}-${String(end + 1)}`;
  });
}

/**
 * The `ledger-run` shard (#1366): how a run's spend reaches the ledger and its turn — the spend the run records
 * as it is made (`runOnce`) and what a failure completes its record with, the one pass of a recovered or resumed
 * run (spend recorded before is not recorded again), what a paused run has spent, and the turn's cost and the
 * spend of the loops a pause leaves.
 */
export function ledgerRunShard() {
  return {
    configFile: "vitest.mutation-ledger-run.config.ts",
    mutate: [
      // the turn's cost and its status, the spend of the paused loops recorded now, the run's end
      ...declarationsOf("src/run/finish.ts", "outcomeOf", "endOf", "stoppedState", "finishRun"),
      // the spend a run records as it is made, and the spend a failed run's record carries
      ...declarationsOf("src/run/run-agent.ts", "runOnce", "failureRecorded"),
      // one more pass: the spend before it is not recorded again, a failure's record carries the whole
      ...declarationsOf("src/run/continue-run.ts", "continueRun"),
      // the spend a recovery starts from: the checkpoint's usage, or the first task's input
      ...declarationsOf(
        "src/run/continue-agent.ts",
        "isInitialUnapplied",
        "withInitial",
        "initialOf",
        "continueAgent",
      ),
      // the spend a resume starts from: every paused loop's and the free-text replies' (#267)
      ...declarationsOf("src/run/resume-agent.ts", "pausedRun", "resumeAgent"),
    ],
  };
}

/**
 * The `ledger-memory` shard (#1366): the spend of a thread's memory — the strategies' update after a finished
 * turn (#844), the compactions before a new execution (#120): every model call recorded once, the budget left
 * for the next, the summary stored with its cost, the masking a compaction reads through.
 */
export function ledgerMemoryShard() {
  return {
    configFile: "vitest.mutation-ledger-memory.config.ts",
    mutate: [
      "src/run/memory.ts",
      "src/run/compaction-parts.ts",
      // the model call and its record, the summary asked again shorter, the stored cost and the budget
      // left; what is due and what the model reads are not money
      ...declarationsOf(
        "src/run/compaction.ts",
        "summaryCall",
        "summaryOf",
        "compactWithModel",
        "compactOne",
        "compactDue",
      ),
    ],
  };
}

/**
 * The `ledger-branch` shard (#1366): the spend of one branch of a launch — its arbiters' decisions counted as
 * they end (#338), a failed branch's spend carried by its error, a cancelled branch's services, the lost
 * passes recorded first (#853) and the visit's limits the branch checks.
 */
export function ledgerBranchShard() {
  return {
    configFile: "vitest.mutation-ledger-branch.config.ts",
    mutate: [
      ...declarationsOf(
        "src/flow/runtime/launch/branch-runner.ts",
        "answeredEnd",
        "ran",
        "ended",
        "runBranch",
      ),
    ],
  };
}

/**
 * The `ledger-a2a-client` shard (#1366): one call of the A2A client — the peer's price charged at the accept
 * and settled after the wait, a refused call charged for neither (#810 AC5).
 */
export function ledgerA2aClientShard() {
  return {
    configFile: "vitest.mutation-ledger-a2a-client.config.ts",
    mutate: [
      ...methodsOf("src/a2a/client/a2a-client.ts", "#call"),
      ...declarationsOf(
        "src/a2a/a2a-rules.ts",
        "priceProblemOf",
        "checkedPrice",
        "priceViolations",
      ),
    ],
  };
}

/**
 * The `ledger-retention` shard (#1366): what the sweep removes once its retention is over — the ledger's old
 * entries (#771) with the other kinds of rows beside them — and the spend of a knowledge base's search (#268):
 * its cost and a reranker's records into the call's frame.
 */
export function ledgerRetentionShard() {
  return {
    configFile: "vitest.mutation-ledger-retention.config.ts",
    mutate: [
      ...declarationsOf("src/infrastructure/retention-sweep.ts", "expiriesOf", "removeExpired"),
      ...declarationsOf("src/components/rag.ts", "reportRerankUsage", "searchTool"),
    ],
  };
}
