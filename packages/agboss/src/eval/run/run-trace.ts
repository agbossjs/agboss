import type { ExecutionOutput } from "../../app/types.js";
import type { HandledErrorRecord } from "../../flow/runtime/child-records.js";
import type { SuiteRunParts } from "./case-run.js";
import type { EvalExecutionTrace } from "./trace.js";
import { executionTraceOf } from "./trace-of.js";

/**
 * A run's trace (#397 PR 2): the last turn's record — masked by the application's and the
 * workflow's PII policies on its way out — with the handled errors and the output the result keeps
 * outside it, masked here by the same policies. No record (a turn run without one) → no trace.
 */
export async function runTraceOf(
  parts: SuiteRunParts,
  last: ExecutionOutput,
): Promise<EvalExecutionTrace | undefined> {
  const { record } = last;
  if (record === undefined) return undefined;
  const mask = parts.deps.pii?.observability;
  // the mask keeps the shape: every string masked, nothing else changed
  const masked = async <TValue>(value: TValue): Promise<TValue> =>
    mask === undefined ? value : ((await mask.value(value)) as TValue);
  const handledErrors: readonly HandledErrorRecord[] = await masked(last.handledErrors);
  return executionTraceOf({
    executionId: last.executionId,
    record,
    handledErrors,
    ...(last.finish === undefined
      ? {}
      : { finish: last.finish.name, output: await masked(last.output) }),
  });
}
