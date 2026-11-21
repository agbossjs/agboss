// The shards of #1356 whose rules are declarations or lines of files with other code (split from stryker-ranges.mjs for max-lines, re-exported by it).

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
      // a limit that is no count is a bound of 0 (#1373)
      "src/graph/count-limit.ts",
      ...limitsChildAndRouterSpend(),
      ...lostPassAndRunSpend(),
    ],
  };
}

/** The limits a visit checks, a child's own spend and a router's spend counted at the call. */
const limitsChildAndRouterSpend = () => [
  "src/flow/runtime/limits.ts",
  "src/flow/runtime/child-exit.ts",
  "src/flow/runtime/runners/router.ts",
];

/** The lost passes' records, what a visit reports, the spend a failure carries and a run's drain of it. */
const lostPassAndRunSpend = () => [
  "src/flow/runtime/lost-pass-records.ts",
  "src/flow/runtime/node-runner.ts",
  "src/run/execute.ts",
  "src/run/paused.ts",
];

/**
 * The `cancel-stores` shard (#1356): the cancel fence of the in-memory and SQLite stores (#909, #1117) — the
 * check that refuses a write of a cancelled tree, the mark on the lease row and its seed row, the lease table's
 * schema and the move of the old marks onto it — and the fenced effects' retention.
 */
export function cancelStoresShard() {
  return {
    configFile: "vitest.mutation-cancel-stores.config.ts",
    mutate: [
      "src/infrastructure/in-memory-database.ts",
      "src/infrastructure/sqlite/sqlite-connection.ts",
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
    mutate: ["src/mesh/mesh-report.ts", "src/a2a/client/a2a-mesh-seam.ts"],
  };
}
