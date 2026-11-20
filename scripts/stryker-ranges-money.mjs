// The shards of #1356 whose rules are declarations or lines of files with other code (split from stryker-ranges.mjs for max-lines, re-exported by it).
import { readFileSync } from "node:fs";

const PACKAGE = new URL("../packages/agboss/", import.meta.url);

/**
 * The top-level declarations `names` of `file` as Stryker ranges (#1356), found by name: from the declaration's
 * own line to the line before the next top-level one (a comment, a declaration or a blank line at column 0),
 * so a file's rules are mutated without the rest of it and a fixed line range never moves with the code above.
 */
export function declarationsOf(file, ...names) {
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  return names.map((name) => {
    const head = new RegExp(
      `^(?:export )?(?:default )?(?:async )?(?:function\\*? |const |class )${name}\\b`,
    );
    const start = lines.findIndex((line) => head.test(line));
    if (start < 0) throw new Error(`${file}: ${name} not found`);
    let end = start;
    while (
      end + 1 < lines.length &&
      lines[end + 1] !== "" &&
      !/^(?:\/\*\*|\/\/|export |const |function |async |interface |type |class )/.test(
        lines[end + 1] ?? "",
      )
    )
      end += 1;
    return `${file}:${String(start + 1)}-${String(end + 1)}`;
  });
}

/** The `store-bound` shard (#1069) of `stryker.config.mjs`, moved here (#1356). */
export function storeBoundShard() {
  return {
    configFile: "vitest.mutation-store-bound.config.ts",
    mutate: [
      "src/app/store-call-{bound,kind,outcome}.ts",
      "src/infrastructure/sqlite/sqlite-{outcome,write-sql}.ts",
      "src/app/lease-abandon.ts",
      "src/app/lease-scope.ts",
    ],
  };
}

/**
 * The `money-runtime` shard (#1356): the rules by which a run's spend is counted where it is made — which
 * visits the budgets check (#656) and the steps and visits limits, a service's spend counted at once (#338),
 * a child's own spend and how its failure reaches its parent (double count or none), the router's spend
 * counted at the call (#1090), the ledger ids of lost passes (#853), the spend a failure carries and the run's
 * drain of it, each branch's spend of a paused run once (#267).
 */
export function moneyRuntimeShard() {
  return {
    configFile: "vitest.mutation-money-runtime.config.ts",
    mutate: [
      ...declarationsOf(
        "src/flow/runtime/limits.ts",
        "isWorkingNode",
        "isBudgeted",
        "checkSteps",
        "checkVisit",
        "countedServiceSpend",
      ),
      ...declarationsOf(
        "src/flow/runtime/child-exit.ts",
        "ownUsageOf",
        "withSpend",
        "isRecordedAs",
        "childFailureOf",
      ),
      ...declarationsOf("src/flow/runtime/runners/router.ts", "counterOf"),
      ...declarationsOf(
        "src/flow/runtime/lost-pass-records.ts",
        "unknownLedgerIdOf",
        "unknownCostRecordsOf",
      ),
      ...declarationsOf("src/flow/runtime/node-runner.ts", "unrecordedSpendOf"),
      ...declarationsOf("src/run/execute.ts", "statesOnly", "unrecordedSpendOf", "drainRun"),
      ...declarationsOf("src/run/paused.ts", "pausedUsageOf"),
    ],
  };
}

/**
 * The `cancel-stores` shard (#1356): the cancel fence of the in-memory and SQLite stores (#909, #1117) — the
 * check that refuses a write of a cancelled tree, the mark on the lease row and its seed row, the lease table's
 * schema and the move of the old marks onto it — and the fenced effects' retention.
 */
export function cancelStoresShard() {
  return {
    configFile: "vitest.mutation-cancel-stores.config.ts",
    mutate: [
      ...declarationsOf(
        "src/infrastructure/in-memory-database.ts",
        "checkInMemoryCancel",
        "prunedFencedBefore",
      ),
      ...declarationsOf(
        "src/infrastructure/sqlite/sqlite-connection.ts",
        "markedCancelRequested",
        "checkSqliteCancel",
      ),
      "src/infrastructure/sqlite/sqlite-lease-schema.ts",
    ],
  };
}

/**
 * The `mesh-charge` shard (#1356): what a call across the mesh is charged and under which ledger identity
 * (#810, Q6 c) — a verified report's charge, a call's price, the identities that make a replay add each once.
 */
export function meshChargeShard() {
  return {
    configFile: "vitest.mutation-mesh-charge.config.ts",
    mutate: [
      ...declarationsOf("src/mesh/mesh-report.ts", "withLedgerKey", "chargeOf"),
      ...declarationsOf("src/a2a/client/a2a-mesh-seam.ts", "priceLedgerKeyOf", "chargePrice"),
    ],
  };
}
