/**
 * Run artifacts for the HTML report's tests (#397 PR 1), written as `agboss eval run --report` writes
 * them: a stable case, an unstable one (passed, failed a check, hit a limit) and a failing one (a
 * turn that paused, a check the cascade skipped).
 */
import { CheckStatus, EvalCascade } from "agboss/eval";
import type { EvalCaseReport, EvalRunReport, EvalRunResult } from "agboss/eval";

const passedRun = (run: number): EvalRunResult => ({
  run,
  threadId: `thread-${String(run)}`,
  executionId: `execution-${String(run)}`,
  finish: "refund-workflow-finish",
  passed: true,
  checks: [
    { check: "trajectory", status: CheckStatus.Passed },
    {
      check: "polite-refund-judge",
      status: CheckStatus.Passed,
      metrics: { politeness: 0.92, tone: "warm" },
      spentUsd: 0.0021,
    },
  ],
  spentUsd: 0.0123,
});

const failedRun = (run: number): EvalRunResult => ({
  run,
  threadId: `thread-f${String(run)}`,
  executionId: `execution-f${String(run)}`,
  finish: "refund-workflow-finish",
  passed: false,
  checks: [
    {
      check: "trajectory",
      status: CheckStatus.Failed,
      reason: "delete-order-tool called (forbidden)",
    },
    { check: "polite-refund-judge", status: CheckStatus.Skipped, skippedBy: "trajectory" },
  ],
  spentUsd: 0.0098,
});

const errorRun = (run: number, code: string, message: string): EvalRunResult => ({
  run,
  threadId: `thread-e${String(run)}`,
  passed: false,
  checks: [],
  error: { code, message },
  spentUsd: 0.004,
});

/** A case's report from its runs, as `caseReportOf` builds it. */
export function caseOf(name: string, runResults: readonly EvalRunResult[]): EvalCaseReport {
  const passed = runResults.filter((result) => result.passed).length;
  const passAtK = passed > 0;
  const passHatK = passed === runResults.length;
  return {
    name,
    caseHash: `hash-${name}`,
    passed,
    runs: runResults.length,
    passAtK,
    passHatK,
    isUnstable: passAtK && !passHatK,
    runResults,
  };
}

/** An artifact of `cases`, its summary counted from them. */
export function artifactOf(cases: readonly EvalCaseReport[], runs = 3): EvalRunReport {
  return {
    kind: "agboss.eval-run",
    schemaVersion: 1,
    suite: "refunds-eval-suite",
    application: { name: "refunds-application", version: "1.4.0" },
    workflow: { name: "refunds-workflow", version: "1.4.0" },
    configHash: "3f9a1c2b7d",
    start: "refund-workflow-start",
    environment: "eval",
    runs,
    cascade: EvalCascade.StopAtFirstFailure,
    startedAt: "2026-01-05T09:00:00.000Z",
    endedAt: "2026-01-05T09:03:05.000Z",
    cases,
    summary: {
      cases: cases.length,
      passAtK: cases.filter((found) => found.passAtK).length,
      passHatK: cases.filter((found) => found.passHatK).length,
      unstable: cases.filter((found) => found.isUnstable).length,
      judgeCalls: 4,
      skippedByCascade: 1,
    },
    spend: { totalUsd: 0.0602 },
  };
}

/** The three cases: stable, unstable, failing. */
export const REFUNDS_ARTIFACT: EvalRunReport = artifactOf([
  caseOf("refund-within-policy", [passedRun(1), passedRun(2), passedRun(3)]),
  caseOf("prohibition-survives-compaction", [
    passedRun(1),
    failedRun(2),
    errorRun(
      3,
      "limit.budget",
      "execution execution-e3 spent $0.0500; execution-budget allows $0.05",
    ),
  ]),
  caseOf("refund-after-a-question", [
    errorRun(1, "execution.paused", "turn 0 paused: the turns after it cannot run"),
    failedRun(2),
    failedRun(3),
  ]),
]);
