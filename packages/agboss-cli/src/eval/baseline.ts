import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CaseComparison,
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
  type EvalCasePasses,
  type EvalCaseReport,
  type EvalModelUse,
  type EvalRunComparison,
  type EvalRunReport,
} from "@agboss/core/eval";
import { flagOption, textOption, type CommandContext } from "../cli/context.js";
import { CliError, usageError } from "../cli/errors.js";
import {
  EVAL_BASELINE_KIND,
  EVAL_BASELINE_SCHEMA_VERSION,
  type CompactBaselineCase,
  type CompactEvalBaseline,
} from "./baseline-compact.js";
import { readRunArtifact, runArtifactInvalid } from "./run-artifact.js";

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
  // the file holds ISO 8601 text; the report holds `Date`s
  const startedAt = new Date(String(raw.startedAt));
  const endedAt = new Date(String(raw.endedAt));
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()))
    throw runArtifactInvalid(file, `invalid ${EVAL_BASELINE_KIND}: startedAt or endedAt`);
  return {
    ...raw,
    startedAt,
    endedAt,
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

/** `provider/model`, how a use is named in a warning. */
const useText = (use: EvalModelUse | undefined): string =>
  use === undefined ? "none" : `${use.provider}/${use.model}`;

/** The components whose model differs between two lists (a component in one only counts). */
function drifted(before: readonly EvalModelUse[], now: readonly EvalModelUse[]) {
  const names = [...new Set([...before, ...now].map((use) => use.component))];
  return names.flatMap((component) => {
    const was = before.find((use) => use.component === component);
    const is = now.find((use) => use.component === component);
    return useText(was) === useText(is) ? [] : [{ component, was, is }];
  });
}

/** What changed in a profile, a model list or a judge list between the baseline and this run. */
function driftOf(
  kind: "model" | "judge",
  before: readonly EvalModelUse[] | undefined,
  now: readonly EvalModelUse[] | undefined,
): string[] {
  // a baseline that kept none (an older compact one) says nothing of them
  if (before === undefined) return [];
  const note =
    kind === "judge" ? " — a changed verdict may be the judge's, not the candidate's" : "";
  return drifted(before, now ?? []).map(
    (found) =>
      `${kind} drift: ${found.component} ran on ${useText(found.was)} in the baseline, on ${useText(found.is)} now${note}`,
  );
}

/**
 * What `--baseline` warns of besides the cases: the profile, the candidate's models and the judges
 * the baseline ran on that this run did not. A judge that changed is the one that matters — the
 * yardstick moved, so a case that "regressed" or "improved" may only have been judged differently.
 */
export function environmentWarningsOf(baseline: EvalRunReport, run: EvalRunReport): string[] {
  const profile =
    baseline.profile === run.profile
      ? []
      : [
          `the baseline ran on profile ${baseline.profile ?? "none"}, this run on ${run.profile ?? "none"}`,
        ];
  return [
    ...profile,
    ...driftOf("model", baseline.models, run.models),
    ...driftOf("judge", baseline.judges, run.judges),
  ];
}
