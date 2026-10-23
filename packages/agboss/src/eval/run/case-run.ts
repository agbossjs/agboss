import type { AppDeps } from "../../app/app-deps.js";
import { executeUnchecked } from "../../app/execute-unchecked.js";
import { ExecutionStatus, type App, type ExecutionOutput } from "../../app/types.js";
import { startLine } from "../../flow/runtime/history.js";
import { AGBossError } from "../../core/errors.js";
import type { ApplicationStart } from "../../application/application-starts.js";
import type { EvalCase, EvalTurn } from "../suite/cases.js";
import { CheckStatus, EvalCascade, isJudgeCheck, type EvalCheck } from "../suite/checks.js";
import type { EvalSuiteMeta } from "../suite/eval-suite.decorator.js";
import { caseContextValuesOf, type CaseContextValues } from "./case-frame.js";
import { writeCaseHistory } from "./case-history.js";
import { runJudgeCheck, type JudgedTurn } from "./judge-check.js";
import {
  TRAJECTORY_CHECK,
  type EvalCheckResult,
  type EvalRunError,
  type EvalRunResult,
} from "./report.js";
import { trajectoryFailures } from "./trajectory.js";
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
  readonly start: ApplicationStart;
  readonly suite: EvalSuiteMeta;
  readonly newThreadId: () => string;
}

/** How the turns of a run went: the last turn's output, or why one could not end. */
type TurnsOutcome =
  | { readonly kind: "ended"; readonly last: ExecutionOutput; readonly spentUsd: number }
  | { readonly kind: "failed"; readonly error: EvalRunError; readonly spentUsd: number };

const errorOf = (error: unknown): EvalRunError =>
  error instanceof AGBossError
    ? { code: error.code, message: error.message }
    : { code: "internal", message: error instanceof Error ? error.message : String(error) };

/** The turns in order on one thread; an earlier turn that pauses stops the run. */
async function runTurns(
  parts: SuiteRunParts,
  written: EvalCase,
  thread: { readonly threadId: string; readonly values: CaseContextValues },
): Promise<TurnsOutcome> {
  const { threadId, values } = thread;
  // the values as validated; `execution` only where the case gives it (the built-in class has none)
  const contexts = {
    tenant: values.tenant,
    ...(written.execution === undefined ? {} : { execution: values.execution }),
  };
  let spentUsd = 0;
  let last: ExecutionOutput | undefined;
  for (const [index, turn] of written.turns.entries()) {
    if (last?.status === ExecutionStatus.Paused) {
      const message = `turn ${String(index)} paused: the turns after it cannot run`;
      return { kind: "failed", error: { code: "execution.paused", message }, spentUsd };
    }
    try {
      last = await executeUnchecked(parts.app, parts.start.component, turn.input, {
        threadId,
        ...contexts,
        record: index === written.turns.length - 1, // the last turn's trajectory (#397 PR 2)
      });
    } catch (error) {
      return { kind: "failed", error: errorOf(error), spentUsd };
    }
    spentUsd += last.spend.totalUsd;
  }
  if (last === undefined) throw new Error(`case "${written.name}" has no turns`);
  return { kind: "ended", last, spentUsd };
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
  for (const check of [...parts.suite.checks, ...(written.judges ?? [])]) {
    if (failed !== undefined && parts.suite.cascade === EvalCascade.StopAtFirstFailure) {
      results.push({ check: checkNameOf(check), status: CheckStatus.Skipped, skippedBy: failed });
      continue;
    }
    const result = await runCheck(parts, written, check, turn);
    if (result.status === CheckStatus.Failed) failed ??= result.check;
    results.push(result);
  }
  return results;
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
