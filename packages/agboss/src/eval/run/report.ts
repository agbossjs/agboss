import type { JudgeMetrics } from "../../components/judge-decorators.js";
import { CheckStatus, type EvalCascade } from "../suite/checks.js";
import type { EvalRunComparison } from "./comparison.js";

/**
 * The run artifact of `agboss eval run --report <run.json>` (#396 PR 2, S3): every case run `runs`
 * times, each run's checks in order, pass@k and pass^k per case and for the suite. Plain JSON — the
 * file a later run compares against (`--baseline`, #396 PR 3) — so it carries its `kind` and the
 * version of its schema.
 */

/** What every run artifact says it is. */
export const EVAL_RUN_KIND = "agboss.eval-run";

/** The version of the artifact's shape: a reader refuses one it does not know. */
export const EVAL_RUN_SCHEMA_VERSION = 1;

/** What one check decided on one run. */
export interface EvalCheckResult {
  /** `trajectory`, or the judge's `name`. */
  readonly check: string;
  readonly status: CheckStatus;
  /** Why it failed. */
  readonly reason?: string;
  /** The failed check that skipped it (`EvalCascade.StopAtFirstFailure`). */
  readonly skippedBy?: string;
  /** What a judge measured. */
  readonly metrics?: JudgeMetrics;
  /** What a judge's model calls cost, in USD (a model judge only). */
  readonly spentUsd?: number;
}

/** Why a run has no checks: a turn failed or paused before the last one ended. */
export interface EvalRunError {
  readonly code: string;
  readonly message: string;
}

/** One run of a case: its turns on one thread, then its checks on the last turn. */
export interface EvalRunResult {
  /** 1 to `runs`. */
  readonly run: number;
  readonly threadId: string;
  /** The last turn's execution: the one the checks judged. */
  readonly executionId?: string;
  /** The finish the last turn ended at; none when it paused or failed. */
  readonly finish?: string;
  /** Every check that ran passed (a skipped one fails the run, S2 Q6). */
  readonly passed: boolean;
  readonly checks: readonly EvalCheckResult[];
  /** The turn that could not end, when one could not (its checks then do not run). */
  readonly error?: EvalRunError;
  /** The turns' executions and the judges' model calls, in USD. */
  readonly spentUsd: number;
}

/** One case over its `runs` runs. */
export interface EvalCaseReport {
  readonly name: string;
  /** The hash of the case as written and the suite's checks: a changed case is not compared. */
  readonly caseHash: string;
  /** How many of its runs passed. */
  readonly passed: number;
  readonly runs: number;
  /** At least one run passed. */
  readonly passAtK: boolean;
  /** Every run passed. */
  readonly passHatK: boolean;
  /** pass@k without pass^k: a candidate for deterministic code, not a longer prompt. */
  readonly isUnstable: boolean;
  readonly runResults: readonly EvalRunResult[];
}

/** The suite's totals. */
export interface EvalRunSummary {
  readonly cases: number;
  /** Cases with pass@k. */
  readonly passAtK: number;
  /** Cases with pass^k. */
  readonly passHatK: number;
  readonly unstable: number;
  /** Judge checks that ran, and those the cascade skipped. */
  readonly judgeCalls: number;
  readonly skippedByCascade: number;
}

/** What a run ran on: the application or the workflow, by name and version. */
export interface EvalRunComponent {
  readonly name: string;
  readonly version: string;
}

/** What a run spent: every turn's execution and every judge's model calls, in USD. */
export interface EvalRunSpend {
  readonly totalUsd: number;
}

/** The whole run artifact. */
export interface EvalRunReport {
  readonly kind: typeof EVAL_RUN_KIND;
  readonly schemaVersion: typeof EVAL_RUN_SCHEMA_VERSION;
  readonly suite: string;
  readonly application: EvalRunComponent;
  readonly workflow: EvalRunComponent;
  /** The workflow's fingerprint (`agboss describe --json`): what the runs ran on. */
  readonly configHash: string;
  readonly start: string;
  readonly environment: string;
  /** How many times each case ran: the k of pass@k. */
  readonly runs: number;
  readonly cascade: EvalCascade;
  /** ISO 8601, the application's `Clock`. */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly cases: readonly EvalCaseReport[];
  readonly summary: EvalRunSummary;
  readonly spend: EvalRunSpend;
  /** The run against `--baseline <run.json>` (#396 PR 3); absent without one. */
  readonly baseline?: EvalRunComparison;
}

/** A case's report from its runs: pass@k = one run passed, pass^k = every run passed (n = k). */
export function caseReportOf(
  name: string,
  caseHash: string,
  runResults: readonly EvalRunResult[],
): EvalCaseReport {
  const passed = runResults.filter((result) => result.passed).length;
  const passAtK = passed > 0;
  const passHatK = runResults.length > 0 && passed === runResults.length;
  const runs = runResults.length;
  return {
    name,
    caseHash,
    passed,
    runs,
    passAtK,
    passHatK,
    isUnstable: passAtK && !passHatK,
    runResults,
  };
}

/** The suite's totals over its cases. */
export function summaryOf(cases: readonly EvalCaseReport[]): EvalRunSummary {
  const checks = cases.flatMap((found) => found.runResults.flatMap((result) => result.checks));
  const judges = checks.filter((check) => check.check !== TRAJECTORY_CHECK);
  return {
    cases: cases.length,
    passAtK: cases.filter((found) => found.passAtK).length,
    passHatK: cases.filter((found) => found.passHatK).length,
    unstable: cases.filter((found) => found.isUnstable).length,
    judgeCalls: judges.filter((check) => check.status !== CheckStatus.Skipped).length,
    skippedByCascade: checks.filter((check) => check.skippedBy !== undefined).length,
  };
}

/** The name of the trajectory check in reports. */
export const TRAJECTORY_CHECK = "trajectory";
