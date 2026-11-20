import { readFileSync } from "node:fs";
import { URL } from "node:url";

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
