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
