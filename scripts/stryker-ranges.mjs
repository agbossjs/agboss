/** The Stryker ranges of `packages/agboss/stryker.config.mjs`: a part of a file found by name, not by a fixed line range. */

/** The `files-pii` shard (#1269) of `stryker.config.mjs`: its tests and the files they kill. */
export function filesPiiShard() {
  return {
    configFile: "vitest.mutation-files-pii.config.ts",
    mutate: [
      "src/files/*.ts",
      "src/pii/{key-hierarchy,tokens}.ts",
      // the hashing, the masking and the spend of the policies' model detectors, taken up by a search and carried by a refusal
      "src/pii/policy-set.ts",
      // #1301: what a sensitive field of a stored output or start line shows — a token or a mask, never the value
      "src/pii/final-output-mask.ts",
      "src/app/history-finish.ts",
    ],
  };
}

/**
 * The `spend` shard (#1356) of `stryker.config.mjs`: what a call or a service cost and which usage counts — the
 * usage record and its multiset key (counted once), the cost of a call and of a service, the usage a checkpoint
 * restores and a response reports, the spend of a queued child, the budget's rules, periods and deadline, and
 * the run's budgets.
 */
export function spendShard() {
  return {
    configFile: "vitest.mutation-spend.config.ts",
    mutate: [
      "src/finops/{record-stream,usage,cost-report,cost-source,cost-category,fallback-mark,served-by}.ts",
      "src/app/restored-usage.ts",
      "src/app/remote/queued-child-spend.ts",
      "src/models/calls/response-usage.ts",
      "src/models/cost.ts",
      "src/components/{spend-recorder,decision-model}.ts",
      "src/application/budget-profile.ts",
      "src/budgets/{budget,budget-overlay,budget-period,budget-rules,budget-spend,execution-deadline}.ts",
      "src/run/run-budgets.ts",
    ],
  };
}

/**
 * The `cancel` shard (#1356) of `stryker.config.mjs`: the cancel of a thread and of a resting tree (its durable
 * mark, a paused tree's undo and end, the sweep of a request that died half way, a request on another instance)
 * and what a lease reports and releases when it is lost, released or taken over.
 */
export function cancelShard() {
  return {
    configFile: "vitest.mutation-takeover.config.ts",
    mutate: [
      "src/app/cancel-{marks,paused,remote,requests,resting,thread,watch}.ts",
      // #1341b: a stop is a cancel that undoes nothing — its requests, thread call and lease marks
      "src/app/{interrupt-controls,interrupt-requests,stop-requests,stop-thread,lease-marks,request-checks,external-pause,take-end}.ts",
      "src/app/{lease-lost,lease-stopped,lease-releases,lease-reporting}.ts",
      // #1325b: a write refused after its tree's cancel, and the one test of what ends a tree as cancelled
      "src/app/cancel-fenced.ts",
      "src/core/execution-cancelled.ts",
      // #1341c: an operator's pause and its lift — the command, the park, the unpause, the pause mark's reads
      "src/app/{pause-thread,unpause-thread,unpause-move,parked-output,paused-tree}.ts",
    ],
  };
}

/**
 * The `fenced-reach` shard (#1356) of `stryker.config.mjs`: the fenced effects a component injects (#890), the
 * execution's fence a step reads and the components that reach a fencing service.
 */
export function fencedReachShard() {
  return {
    configFile: "vitest.mutation-fenced-reach.config.ts",
    mutate: [
      "src/app/idempotency.ts",
      "src/flow/context/execution-fence.ts",
      "src/components/container/fenced-reach.ts",
      // the effect an A2A skill's nodes reach through their deps: a direct-reply skill must reach none (#1319)
      "src/a2a/a2a-effect-reach.ts",
    ],
  };
}

/**
 * The `pauses` shard (#1356) of `stryker.config.mjs`: the built-in in-memory pause store (#265, #267, #941, #946,
 * #1099): its transitions and their closers, the mailboxes of notices and their order, the scans, the
 * reassignment and the record's kind.
 */
export function pausesShard() {
  return {
    configFile: "vitest.mutation-pauses.config.ts",
    mutate: [
      "src/infrastructure/{pause-answer-log,pause-bound,pause-closers,pause-closing,pause-log-repair,pause-mailboxes,pause-notices,pause-reassign-transition,pause-record,pause-replacement,pause-scans,pause-seen,pause-transitions}.ts",
      "src/infrastructure/in-memory-pause-{book,queries,store}.ts",
      // #1307c: an answer is recorded only once its target's permitAnswer said true; fails closed
      "src/app/{answer-permit,answer-parts,pause-expiry-reassign}.ts",
      // #1307, #1310: the limits and the permission of a reassignment and a timeout change — the chain's counts and total wait, the destination, the deadline a change sets, the request's checks
      "src/app/{timeout-request,pause-timeout,pause-limits,pause-reassign-deadline,pause-reassign-plan,pause-reassign-support}.ts",
    ],
  };
}

/**
 * The `pauses-sqlite` shard (#1356) of `stryker.config.mjs`: the built-in SQLite pause store: its schema and
 * migrations, the row statements of each transition, the notices' rows, the scans and the reassignment.
 */
export function pausesSqliteShard() {
  return {
    configFile: "vitest.mutation-pauses-sqlite.config.ts",
    mutate: ["src/infrastructure/sqlite/sqlite-pause-*.ts"],
  };
}

/**
 * The `pause-notices` shard (#1356) of `stryker.config.mjs`: the delivery of a pause's notices to its channel
 * (#940): the claim and its renewal, the retry and the set-aside, the receiving side and the call.
 */
export function pauseNoticesShard() {
  return {
    configFile: "vitest.mutation-pause-notices.config.ts",
    mutate: ["src/app/pause-notice-*.ts"],
  };
}

/**
 * The `rate-limits` shard (#1356) of `stryker.config.mjs`: the built-in rate limit stores — the slots a
 * provider's calls hold across instances, the windows and the pauses after a 429 — and the policy they apply.
 */
export function rateLimitsShard() {
  return {
    configFile: "vitest.mutation-rate-limits.config.ts",
    mutate: [
      "src/infrastructure/rate-limit.repository.ts",
      "src/infrastructure/sqlite/sqlite-rate-limit.repository.ts",
      "src/models/policies/rate-limit-policy.ts",
    ],
  };
}

/** The `a2a-files` shard (#1244) of `stryker.config.mjs`: the A2A file fetch, the files' options and scrub (moved here, #1356). */
export function a2aFilesShard() {
  return {
    configFile: "vitest.mutation-a2a-files.config.ts",
    // the slots (#1256) are the a2a-server shard's
    mutate: [
      "src/a2a/files/**/*.ts",
      "!src/a2a/files/a2a-file-slots.ts",
      // the files' sweep: whose ttl is up, never a live execution's (#1316)
      "src/application/file-expiry.ts",
      // #1316: what bounds a client's downloadFile: its pool and the policy's size limit and timeout
      "src/a2a/client/a2a-download-bounds.ts",
    ],
  };
}

export * from "./stryker-ranges-money.mjs";
export * from "./stryker-ranges-once.mjs";
export * from "./stryker-ranges-fence.mjs";
export * from "./stryker-ranges-ledger.mjs";
export * from "./stryker-ranges-budget.mjs";
export * from "./stryker-ranges-whole.mjs";
