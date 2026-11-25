// The `ledger-*` shards of #1366: the functions that write money — a spend into the ledger, a turn's cost, a
// retention's cut of the ledger — in files with other code (split from stryker-ranges.mjs for max-lines).
import { wholeFile } from "./stryker-ranges-whole.mjs";

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
      "src/run/finish.ts",
      // the spend a run records as it is made, and the spend a failed run's record carries
      "src/run/run-agent.ts",
      // one more pass: the spend before it is not recorded again, a failure's record carries the whole
      "src/run/continue-run.ts",
      // the spend a recovery starts from: the checkpoint's usage, or the first task's input
      "src/run/continue-agent.ts",
      // the spend a resume starts from: every paused loop's and the free-text replies' (#267)
      "src/run/resume-agent.ts",
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
      "src/run/compact-before-run.ts",
      "src/run/compaction-parts.ts",
      // the model call and its record, the summary asked again shorter, the stored cost and the budget
      // left; what is due and what the model reads are not money
      "src/run/compaction.ts",
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
    mutate: ["src/flow/runtime/launch/branch-runner.ts"],
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
      "src/a2a/client/a2a-client.ts",
      // an endpoint's ttl: a limit above the lease
      "src/a2a/a2a-endpoint-ttl.ts",
      // the assembly's rules of a contract: the price is the one that is money, and the choice of the agents whose price is checked (the providers' list) is mutated with it; what is left out is names, descriptions and finish names
      ...wholeFile("src/a2a/a2a-rules.ts", {
        contractNameViolations:
          "checks the suffix of an exposed class's name; no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        startsOf:
          "lists the workflow starts of the workflows; no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        endpointViolations:
          "checks an application's endpoints are endpoints, named once, described and listing a start once; no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        problemsOf:
          "names the finish names a target does not have; no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
        targetFinishesViolations:
          "reports the finish names a target does not have; no number, limit, deadline, step count, spend, ledger id, fence or cancel is decided there",
      }),
    ],
  };
}

/**
 * The `ledger-retention` shard (#1366): what the sweep removes once its retention is over — the ledger's old
 * entries (#771) with the other kinds of rows beside them — and a knowledge base's search (#268): the scope
 * its every call is made for (a data-isolation boundary: it fails closed), its cost, tokens and a reranker's
 * records into the call's frame, each under its own caller.
 */
export function ledgerRetentionShard() {
  return {
    configFile: "vitest.mutation-ledger-retention.config.ts",
    mutate: [
      "src/infrastructure/retention-sweep.ts",
      "src/components/rag.ts",
      "src/components/rag-reranker.ts",
      "src/components/rag-retrieval.ts",
      "src/components/rag-scope.ts",
      "src/rag/rag-source.ts",
      "src/rag/retrieval-spend.ts",
      "src/finops/explicit-caller.ts",
    ],
  };
}
