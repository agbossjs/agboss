import { CheckStatus, type EvalCaseReport, type EvalRunReport } from "@agboss/core/eval";

/** Compact baseline snapshot kind (`--save-baseline <file.json>`). */
export const EVAL_BASELINE_KIND = "agboss.eval-baseline";
/** 2 (#1328): the profile, models and judges it ran on, `executionUsd` average, ISO 8601 timestamps. */
export const EVAL_BASELINE_SCHEMA_VERSION = 2;

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
  /** What it ran on: a later run is warned when its own differs. */
  readonly profile?: EvalRunReport["profile"];
  readonly models?: EvalRunReport["models"];
  readonly judges?: EvalRunReport["judges"];
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
  // the candidate's own spend only: a judge's calls are not what a baseline compares
  const totalSpend = found.runResults.reduce((sum, r) => sum + r.executionUsd, 0);
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
    ...(report.profile === undefined ? {} : { profile: report.profile }),
    ...(report.models === undefined ? {} : { models: report.models }),
    ...(report.judges === undefined ? {} : { judges: report.judges }),
    cases: report.cases.map(compactCaseOf),
  };
}
