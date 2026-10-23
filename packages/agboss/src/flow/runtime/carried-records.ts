import type {
  ExecutionStepRecord,
  GuardrailDecisionRecord,
  JudgeVerdictRecord,
} from "./step-records.js";
import type { ToolCallRecord } from "./tool-calls.js";

/**
 * What a failed visit carries to where its failure is recorded (#395 S6), the way a failure carries
 * the spend its state does not hold: the visit's tool calls, its judges' verdicts and its
 * guardrails' decisions — attached where it failed (the agent's loop, a guardrail), read by the
 * visit that records the failure (a side path, a failed branch) — and, when no side path takes it,
 * the visit's own step record, read by the child execution it ends.
 *
 * Kept beside the error object, never on it: a failure is a public class, its records are not its
 * fields; in this process only, like the error itself.
 */
export interface CarriedRecords {
  readonly toolCalls: readonly ToolCallRecord[];
  readonly judgeVerdicts: readonly JudgeVerdictRecord[];
  readonly guardrailDecisions: readonly GuardrailDecisionRecord[];
  /** The failed visit's step record, once no side path took the failure. */
  readonly steps: readonly ExecutionStepRecord[];
}

const NOTHING: CarriedRecords = {
  toolCalls: [],
  judgeVerdicts: [],
  guardrailDecisions: [],
  steps: [],
};

const carried = new WeakMap<object, CarriedRecords>();

const isObject = (value: unknown): value is object =>
  (typeof value === "object" || typeof value === "function") && value !== null;

/** What a failure carries; nothing for one that carries nothing. */
export const carriedRecordsOf = (error: unknown): CarriedRecords =>
  (isObject(error) ? carried.get(error) : undefined) ?? NOTHING;

/** What a failure carries, taken off it: the child execution it ends keeps them, no parent again. */
export function takeCarriedRecords(error: unknown): CarriedRecords {
  const records = carriedRecordsOf(error);
  if (isObject(error)) carried.delete(error);
  return records;
}

/** Where records join what a failure carries: after it (later records), or before it (earlier ones). */
export enum CarriedOrder {
  After = "after",
  Before = "before",
}

/**
 * Adds records to what a failure carries, each list after (or, for what happened earlier — the
 * loop's state around the node that threw — before) the known one; a value that is no object
 * carries none.
 */
export function carryRecords(
  error: unknown,
  records: Partial<CarriedRecords>,
  order: CarriedOrder = CarriedOrder.After,
): void {
  if (!isObject(error)) return;
  const known = carriedRecordsOf(error);
  const joined = <TItem>(had: readonly TItem[], added: readonly TItem[] | undefined): TItem[] =>
    order === CarriedOrder.After ? [...had, ...(added ?? [])] : [...(added ?? []), ...had];
  carried.set(error, {
    toolCalls: joined(known.toolCalls, records.toolCalls),
    judgeVerdicts: joined(known.judgeVerdicts, records.judgeVerdicts),
    guardrailDecisions: joined(known.guardrailDecisions, records.guardrailDecisions),
    steps: joined(known.steps, records.steps),
  });
}
