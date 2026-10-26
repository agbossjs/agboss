import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalRunReport } from "@agboss/core/eval";
import { evalRunReportOf } from "@agboss/core/internal";

/**
 * The run artifacts of a folder (#397 PR 3: what `agboss eval ui` serves): every `*.json` directly
 * in it, read by the one artifact reader — a file that is not an artifact this version reads is
 * listed with why. Read again on every request: a run written meanwhile shows up.
 */

/** One file of the folder: its artifact, or why it is not one. */
export type RunFile =
  | { readonly kind: "run"; readonly file: string; readonly report: EvalRunReport }
  | { readonly kind: "invalid"; readonly file: string; readonly reason: string };

function readRunFile(folder: string, file: string): RunFile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(folder, file), "utf8"));
  } catch {
    return { kind: "invalid", file, reason: "not JSON" };
  }
  const read = evalRunReportOf(value);
  return read.kind === "read"
    ? { kind: "run", file, report: read.report }
    : { kind: "invalid", file, reason: read.reason };
}

/** The folder's run files: runs newest first, then the files that are not runs, by name. */
export function runFilesOf(folder: string): readonly RunFile[] {
  const names = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const files = names.map((name) => readRunFile(folder, name));
  const runs = files
    .filter((found) => found.kind === "run")
    .sort((left, right) => right.report.startedAt.localeCompare(left.report.startedAt));
  return [...runs, ...files.filter((found) => found.kind === "invalid")];
}
