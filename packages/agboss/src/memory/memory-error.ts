import { StepError } from "../core/error-families/step-errors.js";
import { stepCoordinatesOf } from "../graph/errors.js";
import { ComponentKind } from "../flow/runtime/records.js";
import type { SummaryMaxTokens } from "./memory.decorator.js";

/** What a failed compaction takes: the message, the memory and the cut limit. */
export interface MemoryErrorOptions {
  readonly message: string;
  /** The `@Memory`'s `name`. */
  readonly memory: string;
  /** The limit the summary was cut at; `undefined` for a code compaction's failure. */
  readonly summaryMaxTokens: SummaryMaxTokens | undefined;
  /** The model call's failure, or what the code compaction's `compact()` threw. */
  readonly cause?: unknown;
}

/**
 * A memory could not compact (#1303): the summary was cut at `summaryMaxTokens` twice — the first
 * answer, then the one asked to be shorter —, its model call failed (the failure as `cause`), or its
 * `compact()` threw, gave no summaries or an empty one. Never a cut summary: the compaction runs before
 * a new execution reads its thread (#120 S132), so that execution fails before any of its work — no
 * model call of its own, no step, no turn kept — and the earlier turns stay unsummarised for the next
 * one. Its spend is already recorded call by call, so `usage` is empty.
 */
export function memoryError(options: MemoryErrorOptions): StepError.Memory {
  const { message, memory, summaryMaxTokens, cause } = options;
  return new StepError.Memory({
    ...stepCoordinatesOf(memory, ComponentKind.Memory),
    memory,
    message,
    ...(cause === undefined ? {} : { cause }),
    details: { memory, ...(summaryMaxTokens === undefined ? {} : { summaryMaxTokens }) },
  });
}

/** Whether `error` is a memory's failure. */
export const isMemoryError = (error: unknown): error is StepError.Memory =>
  error instanceof StepError.Memory;
