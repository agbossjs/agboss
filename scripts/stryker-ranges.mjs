import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { methodsOf } from "./stryker-ranges-ledger.mjs";

/** The Stryker ranges of `packages/agboss/stryker.config.mjs`: a part of a file found by name, not by a fixed line range. */

/** The package the ranges name files of. */
const PACKAGE = new URL("../packages/agboss/", import.meta.url);

/**
 * `keyTextRuleOf` and its rules in `file` as a Stryker range: from the `Breach` type to the end of
 * the function, found by name — a fixed line range would move with every change above it.
 */
export function keyTextRulesOf(file) {
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  const from = lines.findIndex((line) => line.startsWith("type Breach ="));
  const start = lines.findIndex((line) => line.startsWith("export function keyTextRuleOf("));
  const end = start + lines.slice(start).indexOf("}");
  if (from < 0 || start < 0 || end < start) throw new Error(`${file}: keyTextRuleOf not found`);
  return `${file}:${String(from + 1)}-${String(end + 1)}`;
}

/**
 * `SettledSpendCheckpointSaver` and `settledSaverOf` in `file` as a Stryker range (#776): from the
 * class to the end of the file, found by name — the leased and ordered checkpointers above it are
 * not money.
 */
export function settledSpendSaverOf(file) {
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("export class SettledSpendCheckpointSaver "),
  );
  const end = lines.findLastIndex((line) => line.trim() !== "");
  if (start < 0 || end < start) throw new Error(`${file}: SettledSpendCheckpointSaver not found`);
  return `${file}:${String(start + 1)}-${String(end + 1)}`;
}

/**
 * `audienceRefusalOf` in `file` as a Stryker range (#809): from its comment to its end, found by
 * name — the signature checks below it are the fencing shard's tests', not the client's.
 */
export function audienceRefusalOf(file) {
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("export const audienceRefusalOf"));
  const end = start + lines.slice(start).indexOf("};");
  if (start < 0 || end < start) throw new Error(`${file}: audienceRefusalOf not found`);
  return `${file}:${String(start + 1)}-${String(end + 1)}`;
}

/**
 * The stall bound of a streamed answer in `file` as two Stryker ranges (#1125): `StreamStalledError` and
 * `readWithin`, found by name — the rest of the wire guard is the guard's own, not this bound's.
 */
export function stallBoundOf(file) {
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  const rangeFrom = (first) => {
    const start = lines.findIndex((line) => line.startsWith(first));
    const end = start + lines.slice(start).indexOf("}");
    if (start < 0 || end < start) throw new Error(`${file}: ${first} not found`);
    return `${file}:${String(start + 1)}-${String(end + 1)}`;
  };
  return [rangeFrom("export class StreamStalledError"), rangeFrom("async function readWithin(")];
}

/**
 * The hashing of `PiiPolicySet` in `file` as a Stryker range (#1269): from its hashed policies to the end
 * of `withFieldKey`, found by name — the masking around it is the boundary's, not the key hierarchy's.
 */
export function policySetHashingOf(file) {
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("  /** The policies as hashed"));
  const method = lines.findIndex((line) => line.startsWith("  withFieldKey("));
  const end = method + lines.slice(method).indexOf("  }");
  if (start < 0 || method < start || end < method)
    throw new Error(`${file}: the policy set's hashing not found`);
  return `${file}:${String(start + 1)}-${String(end + 1)}`;
}

/** The `files-pii` shard (#1269) of `stryker.config.mjs`: its tests and the files they kill. */
export function filesPiiShard() {
  return {
    configFile: "vitest.mutation-files-pii.config.ts",
    mutate: [
      "src/files/*.ts",
      "src/pii/{key-hierarchy,tokens}.ts",
      policySetHashingOf("src/pii/policy-set.ts"),
      // the spend of the policies' model detectors, taken up by a search and carried by a refusal
      ...methodsOf("src/pii/policy-set.ts", "mask", "refusalError"),
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
      "src/finops/{record-stream,usage,cost-source,cost-category,fallback-mark,served-by}.ts",
      "src/app/restored-usage.ts",
      "src/app/remote/queued-child-spend.ts",
      "src/models/calls/response-usage.ts",
      "src/models/cost.ts",
      "src/components/spend-recorder.ts",
      "src/budgets/{budget,budget-period,budget-rules,execution-deadline}.ts",
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
      "src/app/cancel-{marks,paused,requests,resting,thread}.ts",
      "src/app/{lease-lost,lease-releases,lease-reporting}.ts",
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
      "src/app/fenced-effects.ts",
      "src/flow/context/execution-fence.ts",
      "src/components/container/fenced-reach.ts",
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
      "src/infrastructure/{pause-answer-log,pause-bound,pause-closers,pause-closing,pause-log-repair,pause-mailboxes,pause-notices,pause-reassign-transition,pause-record,pause-replacement,pause-scans,pause-transitions}.ts",
      "src/infrastructure/in-memory-pause-{book,queries,store}.ts",
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
    mutate: ["src/a2a/files/**/*.ts", "!src/a2a/files/a2a-file-slots.ts"],
  };
}

export * from "./stryker-ranges-money.mjs";
export * from "./stryker-ranges-once.mjs";
export * from "./stryker-ranges-fence.mjs";
export * from "./stryker-ranges-ledger.mjs";
export * from "./stryker-ranges-budget.mjs";
