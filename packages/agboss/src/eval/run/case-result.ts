import { usd, type Usd } from "../../units/index.js";
import type { ExecutionOutput, ExecutionStatus } from "../../app/types.js";
import {
  EvalCheckKind,
  type EvalCheckResult,
  type EvalRunError,
  type EvalRunResult,
} from "./report.js";
import type { EvalExecutionTrace } from "./trace.js";

/**
 * The parts of a run's result that are not its checks (#1328d): a run that failed before its
 * checks (a turn, or the status the case expects), and the spend split between the candidate's
 * executions and the judges.
 */

/** A run that ended where the case does not expect: how it ended and how it should have. */
export const statusMismatchOf = (
  last: ExecutionOutput,
  expected: ExecutionStatus,
): EvalRunError => ({
  code: "execution.status-mismatch",
  message: `the last turn ended ${last.status}, the case expects ${expected}`,
});

/** A run with no checks: the error that stopped it, and what its turns spent. */
export const failedRunOf = (
  ids: { readonly run: number; readonly threadId: string; readonly tenantId: string },
  error: EvalRunError,
  spentUsd: Usd,
  found: { readonly executionId?: string; readonly trace?: EvalExecutionTrace | undefined } = {},
): EvalRunResult => ({
  ...ids,
  ...(found.executionId === undefined ? {} : { executionId: found.executionId }),
  passed: false,
  checks: [],
  error,
  executionUsd: spentUsd,
  judgeUsd: usd(0),
  totalUsd: spentUsd,
  ...(found.trace === undefined ? {} : { trace: found.trace }),
});

/**
 * A run's spend: a judge's calls are the judges', the turns and a variant's runs (`metamorphic`)
 * are the candidate's.
 */
export function spendOf(
  turnsUsd: Usd,
  checks: readonly EvalCheckResult[],
): Pick<EvalRunResult, "executionUsd" | "judgeUsd" | "totalUsd"> {
  const spentBy = (kind: EvalCheckKind): number =>
    checks.reduce((sum, check) => sum + (check.kind === kind ? (check.spentUsd ?? 0) : 0), 0);
  const judgeUsd = usd(spentBy(EvalCheckKind.Judge));
  const executionUsd = usd(turnsUsd + spentBy(EvalCheckKind.Metamorphic));
  return { executionUsd, judgeUsd, totalUsd: usd(executionUsd + judgeUsd) };
}
