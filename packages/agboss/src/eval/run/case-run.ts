import type { AppDeps } from "../../app/app-deps.js";
import type { AssembledWorkflow } from "../../workflow.js";
import type { App, ExecutionOutput } from "../../app/types.js";
import { startLine } from "../../flow/runtime/history.js";
import type { ApplicationStart } from "../../application/application-starts.js";
import type { EvalCase, EvalTurn } from "../suite/cases.js";
import { CheckStatus, EvalCascade, isJudgeCheck, type EvalCheck } from "../suite/checks.js";
import type { EvalSuiteMeta } from "../suite/eval-suite.decorator.js";
import { caseContextValuesOf, type CaseContextValues } from "./case-frame.js";
import { runTurns } from "./case-turns.js";
import { writeCaseHistory } from "./case-history.js";
import { runJudgeCheck, type JudgedTurn } from "./judge-check.js";
import {
  METAMORPHIC_CHECK,
  TRAJECTORY_CHECK,
  type EvalCheckResult,
  type EvalRunResult,
} from "./report.js";
import { trajectoryFailures } from "./trajectory.js";
import { runMetamorphicCheck } from "./metamorphic.js";
import { runTraceOf } from "./run-trace.js";
import { nameOf } from "../../components/name-of.js";

/**
 * One run of one case (#396 PR 2): a thread of its own — its `history` written, its `turns` run in
 * order through the application (`app.execute`, the case's `tenant` / `execution` validated as
 * there) — then the checks on the last turn, in order, under the suite's cascade.
 */

/** What every run of a suite runs on. */
export interface SuiteRunParts {
  readonly app: App;
  /** The run dependencies of the workflow the suite's start opens. */
  readonly deps: AppDeps;
  /** The workflow as assembled (a profile applied): what the artifact's header reads. */
  readonly bundle: AssembledWorkflow;
  readonly start: ApplicationStart;
  readonly suite: EvalSuiteMeta;
  readonly newThreadId: () => string;
  /** `--metamorphic` (#396 PR 7): each case's variants run too, after its checks. */
  readonly isMetamorphic?: boolean;
}

/** The name of a check in reports. */
export const checkNameOf = (check: EvalCheck): string =>
  isJudgeCheck(check) ? nameOf(check.judge) : TRAJECTORY_CHECK;

async function runCheck(
  parts: SuiteRunParts,
  written: EvalCase,
  check: EvalCheck,
  turn: JudgedTurn,
): Promise<EvalCheckResult> {
  if (isJudgeCheck(check)) return runJudgeCheck(parts.deps, check.judge, turn);
  const failures = trajectoryFailures(written.tools, turn.toolCalls);
  if (failures.length === 0) return { check: TRAJECTORY_CHECK, status: CheckStatus.Passed };
  return { check: TRAJECTORY_CHECK, status: CheckStatus.Failed, reason: failures.join("; ") };
}

/** The suite's checks, then the case's own judges, under the cascade. */
async function runChecks(
  parts: SuiteRunParts,
  written: EvalCase,
  turn: JudgedTurn,
): Promise<readonly EvalCheckResult[]> {
  const results: EvalCheckResult[] = [];
  let failed: string | undefined;
  const isStopping = (): boolean =>
    failed !== undefined && parts.suite.cascade === EvalCascade.StopAtFirstFailure;
  for (const check of [...parts.suite.checks, ...(written.judges ?? [])]) {
    if (isStopping()) {
      results.push({ check: checkNameOf(check), status: CheckStatus.Skipped, skippedBy: failed });
      continue;
    }
    const result = await runCheck(parts, written, check, turn);
    if (result.status === CheckStatus.Failed) failed ??= result.check;
    results.push(result);
  }
  const metamorphic = await metamorphicResultOf(
    parts,
    written,
    turn,
    isStopping() ? failed : undefined,
  );
  return metamorphic === undefined ? results : [...results, metamorphic];
}

/**
 * `--metamorphic` (#396 PR 7), after every other check — the costliest, the variants' runs:
 * skipped when the cascade stopped at `skippedBy`; none for a case without variants.
 */
async function metamorphicResultOf(
  parts: SuiteRunParts,
  written: EvalCase,
  turn: JudgedTurn,
  skippedBy: string | undefined,
): Promise<EvalCheckResult | undefined> {
  if (parts.isMetamorphic !== true || (written.variants?.length ?? 0) === 0) return undefined;
  if (skippedBy !== undefined)
    return { check: METAMORPHIC_CHECK, status: CheckStatus.Skipped, skippedBy };
  return (await runMetamorphicCheck(parts, written, turn.values, turn.toolCalls)).result;
}

const judgedTurnOf = (
  parts: SuiteRunParts,
  lastTurn: EvalTurn | undefined,
  last: ExecutionOutput,
  values: CaseContextValues,
): JudgedTurn => ({
  executionId: last.executionId,
  threadId: last.threadId,
  values,
  finish: last.finish,
  output: last.output,
  task: startLine(parts.start.name, lastTurn?.input),
  toolCalls: last.toolCalls,
});

/** One run of a case: its result, every check that ran passed or not. */
export async function runCaseOnce(
  parts: SuiteRunParts,
  written: EvalCase,
  run: number,
): Promise<EvalRunResult> {
  const values = caseContextValuesOf(parts.deps, written);
  const threadId = parts.newThreadId();
  await writeCaseHistory(
    parts.deps,
    { tenantId: values.tenant.tenantId, threadId },
    written.history ?? [],
  );
  const turns = await runTurns(parts, written, { threadId, values });
  if (turns.kind === "failed")
    return {
      run,
      threadId,
      passed: false,
      checks: [],
      error: turns.error,
      spentUsd: turns.spentUsd,
    };
  const { last } = turns;
  const turn = judgedTurnOf(parts, written.turns.at(-1), last, values);
  const checks = await runChecks(parts, written, turn);
  const judged = checks.reduce((sum, check) => sum + (check.spentUsd ?? 0), 0);
  const trace = await runTraceOf(parts, last);
  return {
    run,
    threadId,
    executionId: last.executionId,
    ...(last.finish === undefined ? {} : { finish: last.finish.name }),
    passed: checks.every((check) => check.status === CheckStatus.Passed),
    checks,
    spentUsd: turns.spentUsd + judged,
    ...(trace === undefined ? {} : { trace }),
  };
}
