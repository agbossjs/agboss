// The shards of #1366 (fence, lease and cancel) whose rules are declarations of files with other code (split from stryker-ranges.mjs for max-lines, re-exported by it).

/** The `takeover` shard of `stryker.config.mjs`, moved here to keep that file under its line limit (#1366). */
export function takeoverShard() {
  return {
    configFile: "vitest.mutation-takeover.config.ts",
    mutate: [
      "src/app/lease-yields.ts",
      "src/app/execution-leases.ts",
      "src/app/handed-over.ts",
      // #1325a: a hand-over is no failure (its kinds, codes and the record guard) and the families' classes
      "src/core/error-families/run-errors.ts:216-237",
      "src/core/error-families/family.ts",
      // a paid family error's spend, read through the report finops/cost-report sets
      "src/core/error-families/spend-report.ts",
    ],
  };
}

/**
 * The `fence-checkpoint` shard (#1366, #1165): the checkpoint a holder writes only after it renewed its lease,
 * the checkpoint that is the latest of its thread after a clock step back, and the leg that is announced only
 * while its lease is still held.
 */
export function fenceCheckpointShard() {
  return {
    configFile: "vitest.mutation-fence-checkpoint.config.ts",
    mutate: ["src/app/leased-checkpointer.ts", "src/app/observed-pass.ts"],
  };
}

/**
 * The `fence-tree` shard (#1366, #1065): the end of a tree whose instance died, taken under the tree's lease,
 * the pause deadline's drain and move, and a child's failure announced by the pass that holds the tree.
 */
export function fenceTreeShard() {
  return {
    configFile: "vitest.mutation-fence-tree.config.ts",
    mutate: [
      "src/app/orphan-tree.ts",
      "src/app/tree-expiry.ts",
      "src/flow/runtime/child-failure.ts",
    ],
  };
}

/**
 * The `fence-workers` shard (#1366): the claims of the queued children's workers under a lease each, and the
 * lease and slots a step runs under.
 */
export function fenceWorkersShard() {
  return {
    configFile: "vitest.mutation-fence-workers.config.ts",
    mutate: [
      "src/app/remote/child-workers.ts",
      "src/app/remote/claimed-child-run.ts",
      "src/app/remote/pre-held.ts",
      "src/flow/runtime/step-frame.ts",
    ],
  };
}

/**
 * The `fence-config` shard (#1366): the assembly's pairing of a fencing store with the lease store, and a
 * retention that stays above the lease.
 */
export function fenceConfigShard() {
  return {
    configFile: "vitest.mutation-fence-config.config.ts",
    mutate: ["src/application/implementations.ts", "src/application/retention.ts"],
  };
}

/**
 * The `cancel-x-runs` shard (#1366): the runs in flight a cancel aborts, by thread and by tree, a branch that
 * ends cancelled or passes a stop through, and the wait for a remote task that is cancelled at its deadline.
 */
export function cancelRunsShard() {
  return {
    configFile: "vitest.mutation-cancel-x-runs.config.ts",
    mutate: [
      "src/app/live-runs.ts",
      "src/a2a/client/a2a-waiter.ts",
      "src/flow/runtime/launch/branch-end.ts",
    ],
  };
}

/**
 * The `cancel-x-pauses` shard (#1366): a tree's end that closes its pauses (cancelled or not taken), the
 * expiry that a cancel beats, the pauses a launch withdraws and the pause step's answer.
 */
export function cancelPausesShard() {
  return {
    configFile: "vitest.mutation-cancel-x-pauses.config.ts",
    mutate: [
      "src/app/pause-expiry.ts",
      "src/app/tree-end-pauses.ts",
      "src/flow/runtime/launch/withdrawn-pauses.ts",
      "src/flow/runtime/pause.ts",
      "src/flow/runtime/pause-open.ts",
    ],
  };
}
