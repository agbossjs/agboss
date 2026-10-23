import {
  CaseComparison,
  type EvalCasePasses,
  type EvalRunComparison,
  type EvalRunReport,
} from "agboss/eval";
import { flagOption, textOption, type CommandContext } from "../cli/context.js";
import { CliError, usageError } from "../cli/errors.js";
import { readRunArtifact, runArtifactInvalid } from "./run-artifact.js";

/**
 * `agboss eval run --baseline <run.json> [--fail-on-regression]` (#396 PR 3): the baseline artifact
 * read before anything runs by the one artifact reader (`eval.run-not-found` / `eval.run-invalid`,
 * exit 2), each case's verdict printed after the
 * run, and with `--fail-on-regression` a regression is exit 5 (`eval.regressed`) — a case that only
 * flapped on the baseline never fails.
 */

/** The baseline `--baseline` names, read and checked; undefined without the option. */
export interface Baseline {
  readonly file: string;
  readonly report: EvalRunReport;
}

/** The baseline of the run; `--fail-on-regression` without one is a usage error. */
export function baselineOf(context: CommandContext, suite: string): Baseline | undefined {
  const file = textOption(context.values, "baseline");
  if (file === undefined) {
    if (flagOption(context.values, "fail-on-regression"))
      throw usageError("eval run", "usage.missing-option", "--fail-on-regression needs --baseline");
    return undefined;
  }
  const report = readRunArtifact(context, file);
  if (report.suite !== suite)
    throw runArtifactInvalid(file, `a run of ${report.suite}, not of ${suite}`);
  return { file, report };
}

const VERDICT_TEXT: Readonly<Record<CaseComparison, string>> = {
  [CaseComparison.Regressed]: "regressed",
  [CaseComparison.Improved]: "improved",
  [CaseComparison.Unchanged]: "unchanged",
  [CaseComparison.FlakyOnBaseline]: "flaky-on-baseline (quarantined)",
  [CaseComparison.New]: "new",
  [CaseComparison.Removed]: "removed",
  [CaseComparison.Changed]: "changed (not compared)",
};

const passesText = (passes: EvalCasePasses | undefined): string =>
  passes === undefined ? "—" : `${String(passes.passed)}/${String(passes.runs)}`;

/** One row per case — baseline, candidate, verdict — and the counts. */
export function comparisonLines(comparison: EvalRunComparison): string[] {
  const rows = comparison.cases.map((found) => [
    found.name,
    passesText(found.baseline),
    passesText(found.candidate),
    VERDICT_TEXT[found.comparison],
  ]);
  const header = ["case", "baseline", "candidate", "verdict"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const table = [header, ...rows].map((row) =>
    row.map((cell, column) => (column === 3 ? cell : cell.padEnd(widths[column] ?? 0))).join("  "),
  );
  return [...table, countsLine(comparison)];
}

/** `1 regressed · 1 quarantined · 1 unchanged`, the verdicts that occur, in the enum's order. */
function countsLine(comparison: EvalRunComparison): string {
  const counts = Object.values(CaseComparison).flatMap((verdict) => {
    const count = comparison.cases.filter((found) => found.comparison === verdict).length;
    const label = verdict === CaseComparison.FlakyOnBaseline ? "quarantined" : verdict;
    return count === 0 ? [] : [`${String(count)} ${label}`];
  });
  return counts.join(" · ");
}

/** With `--fail-on-regression`: the quality failure (exit 5) when a case regressed. */
export function regressionFailure(
  context: CommandContext,
  comparison: EvalRunComparison,
): CliError | undefined {
  const { regressed } = comparison;
  if (!flagOption(context.values, "fail-on-regression") || regressed.length === 0) return undefined;
  const cases = `${String(regressed.length)} case${regressed.length === 1 ? "" : "s"}`;
  const message = `${cases} regressed against ${comparison.file}: ${regressed.join(", ")}`;
  return new CliError("quality", "eval.regressed", message);
}
