import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CaseComparison,
  CheckStatus,
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
  type EvalCasePasses,
  type EvalCaseReport,
  type EvalRunComparison,
  type EvalRunReport,
} from "agboss/eval";
import { flagOption, textOption, type CommandContext } from "../cli/context.js";
import { CliError, usageError } from "../cli/errors.js";
import { readRunArtifact, runArtifactInvalid } from "./run-artifact.js";

/** Compact baseline snapshot kind (`--save-baseline <file.json>`). */
export const EVAL_BASELINE_KIND = "agboss.eval-baseline";
export const EVAL_BASELINE_SCHEMA_VERSION = 1;

/** Per-case metrics in a compact git-diff-friendly baseline file. */
export interface CompactBaselineCase {
  readonly caseId: string;
  readonly caseHash: string;
  readonly runs: number;
  readonly passed: number;
  readonly passAtK: boolean;
  readonly passHatK: boolean;
  readonly flaky: boolean;
  readonly avgSpendUsd: number;
  readonly verdictSummary: string;
}

/** Compact baseline file written by `agboss eval run --save-baseline <file.json>`. */
export interface CompactEvalBaseline {
  readonly kind: typeof EVAL_BASELINE_KIND;
  readonly schemaVersion: typeof EVAL_BASELINE_SCHEMA_VERSION;
  readonly suite: EvalRunReport["suite"];
  readonly application: EvalRunReport["application"];
  readonly workflow: EvalRunReport["workflow"];
  readonly configHash: EvalRunReport["configHash"];
  readonly start: EvalRunReport["start"];
  readonly environment: EvalRunReport["environment"];
  readonly runs: EvalRunReport["runs"];
  readonly cascade: EvalRunReport["cascade"];
  readonly startedAt: EvalRunReport["startedAt"];
  readonly endedAt: EvalRunReport["endedAt"];
  readonly summary: EvalRunReport["summary"];
  readonly spend: EvalRunReport["spend"];
  readonly cases: readonly CompactBaselineCase[];
}

function verdictSummaryOf(found: EvalCaseReport): string {
  const names = [...new Set(found.runResults.flatMap((r) => r.checks.map((c) => c.check)))];
  if (names.length === 0) return `${String(found.passed)}/${String(found.runs)} passed`;
  const parts = names.map((check) => {
    const ok = found.runResults.filter((r) =>
      r.checks.some((c) => c.check === check && c.status === CheckStatus.Passed),
    ).length;
    return `${check}: ${String(ok)}/${String(found.runs)} passed`;
  });
  return `${String(found.passed)}/${String(found.runs)} passed (${parts.join(", ")})`;
}

function compactCaseOf(found: EvalCaseReport): CompactBaselineCase {
  const totalSpend = found.runResults.reduce((sum, r) => sum + r.spentUsd, 0);
  const avgSpendUsd =
    found.runResults.length === 0 ? 0 : Number((totalSpend / found.runResults.length).toFixed(6));
  return {
    caseId: found.name,
    caseHash: found.caseHash,
    runs: found.runs,
    passed: found.passed,
    passAtK: found.passAtK,
    passHatK: found.passHatK,
    flaky: found.isUnstable,
    avgSpendUsd,
    verdictSummary: verdictSummaryOf(found),
  };
}

/** Converts a full `EvalRunReport` into a compact, git-diff-friendly `CompactEvalBaseline`. */
export function compactBaselineOf(report: EvalRunReport): CompactEvalBaseline {
  return {
    kind: EVAL_BASELINE_KIND,
    schemaVersion: EVAL_BASELINE_SCHEMA_VERSION,
    suite: report.suite,
    application: report.application,
    workflow: report.workflow,
    configHash: report.configHash,
    start: report.start,
    environment: report.environment,
    runs: report.runs,
    cascade: report.cascade,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    summary: report.summary,
    spend: report.spend,
    cases: report.cases.map(compactCaseOf),
  };
}

function readCompactBaseline(
  file: string,
  raw: Omit<CompactEvalBaseline, "schemaVersion"> & { readonly schemaVersion?: number },
): EvalRunReport {
  if (raw.schemaVersion !== EVAL_BASELINE_SCHEMA_VERSION)
    throw runArtifactInvalid(file, `invalid ${EVAL_BASELINE_KIND}`);
  const cases: EvalCaseReport[] = raw.cases.map((c: CompactBaselineCase) => ({
    name: c.caseId,
    caseHash: c.caseHash,
    passed: c.passed,
    runs: c.runs,
    passAtK: c.passAtK,
    passHatK: c.passHatK,
    isUnstable: c.flaky,
    runResults: [],
  }));
  return {
    ...raw,
    kind: EVAL_RUN_KIND,
    schemaVersion: EVAL_RUN_SCHEMA_VERSION,
    cases,
  };
}

function readBaselineOrRun(context: CommandContext, path: string): EvalRunReport {
  const full = resolve(context.io.cwd, path);
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    throw new CliError("usage", "eval.run-not-found", `no run artifact at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw runArtifactInvalid(path, "not JSON");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { kind?: unknown }).kind === EVAL_BASELINE_KIND
  ) {
    return readCompactBaseline(path, parsed as CompactEvalBaseline);
  }
  return readRunArtifact(context, path);
}

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
  const report = readBaselineOrRun(context, file);
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
