import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalLabel } from "@agboss/core/eval";
import { evalLabelsOf, labelsWith } from "@agboss/core/internal";
import { writeAtomically } from "./atomic-write.js";

/**
 * The labels file of a suite as `agboss eval ui` reads and writes it (#397 PR 4): the C4 file
 * `eval/labels/<suite>.jsonl` (#396 PR 4's format, what `agboss eval calibrate` reads), a label of
 * the same run, judge and labeler replaced in place, the file written whole — to a temporary file
 * beside it, then renamed over it, so a reader never sees half a file.
 */

/** A suite's name as a file name: what `-eval-suite` names are made of, nothing else. */
const SUITE_NAME = /^[a-z0-9][a-z0-9-]*$/u;

/** The labels of a suite, or why they cannot be read (or written). */
export type SuiteLabels =
  | { readonly kind: "read"; readonly file: string; readonly labels: readonly EvalLabel[] }
  | { readonly kind: "invalid"; readonly file: string; readonly reason: string };

/** The file of a suite's labels; undefined for a suite name that is not a file name. */
export const labelsFileOf = (folder: string, suite: string): string | undefined =>
  SUITE_NAME.test(suite) ? join(folder, `${suite}.jsonl`) : undefined;

/** A suite's labels: none when the file does not exist yet. */
export function suiteLabelsOf(folder: string, suite: string): SuiteLabels {
  const file = labelsFileOf(folder, suite);
  if (file === undefined) return { kind: "invalid", file: suite, reason: "not a suite name" };
  if (!existsSync(file)) return { kind: "read", file, labels: [] };
  const read = evalLabelsOf(readFileSync(file, "utf8"));
  return read.kind === "read"
    ? { kind: "read", file, labels: read.labels }
    : { kind: "invalid", file, reason: `line ${String(read.line)}: ${read.reason}` };
}

/** Writes the suite's labels with `label` in them, atomically. */
export function saveSuiteLabel(file: string, label: EvalLabel): void {
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeAtomically(file, labelsWith(content, label));
}
