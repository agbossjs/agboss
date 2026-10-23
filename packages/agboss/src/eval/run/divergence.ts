import type { EvalCaseReport } from "./report.js";
import type { EvalStepTrace } from "./trace.js";

/**
 * Where the attempts of an unstable case part ways (#397 PR 2): its runs' steps compared position
 * by position — the first step whose node, input, decisions or tool calls are not the same in
 * every run. A node that read the same input and decided differently is the place to make
 * deterministic; one whose input differed was handed the difference by the step before it.
 */

/** What differed first at the step where the runs part ways. */
export enum AttemptDivergenceReason {
  /** The runs went on to different nodes after it: it chose differently. */
  NextStep = "next-step",
  /** The same node read another input: the steps before it gave different values. */
  Input = "input",
  /** The same input, other judge verdicts or guardrail decisions. */
  Verdicts = "verdicts",
  /** The same input, other tool calls (tools, arguments or outcomes). */
  ToolCalls = "tool-calls",
  /** Some runs ended here, others went on. */
  Length = "length",
  /** The same steps throughout, another final output: the last step answered differently. */
  Output = "output",
}

/** The step where a case's attempts first differ. */
export interface AttemptDivergence {
  /** The node where they part ways (for `NextStep` and `Length`, the last one they shared). */
  readonly nodeId: string;
  readonly visitNumber: number;
  /** Its position in the runs' steps, from 0. */
  readonly stepIndex: number;
  readonly reason: AttemptDivergenceReason;
  /** The runs compared, by number (only runs that kept their steps). */
  readonly runs: readonly number[];
}

/** One run's steps and output. */
interface TracedRun {
  readonly run: number;
  readonly steps: readonly EvalStepTrace[];
  readonly output: unknown;
}

const decisionsOf = (step: EvalStepTrace): string =>
  JSON.stringify([
    step.judgeVerdicts.map((verdict) => [verdict.judge, verdict.attempt, verdict.passed]),
    step.guardrailDecisions.map((decision) => [decision.guardrail, decision.isBlocked]),
  ]);

const toolCallsOf = (step: EvalStepTrace): string =>
  JSON.stringify(step.toolCalls.map((call) => [call.tool, call.status, call.input]));

const isSame = (steps: readonly EvalStepTrace[], key: (step: EvalStepTrace) => string): boolean =>
  new Set(steps.map(key)).size === 1;

/** What differs between the runs' steps at one position; undefined when they are the same. */
function reasonAt(
  steps: readonly (EvalStepTrace | undefined)[],
): AttemptDivergenceReason | undefined {
  const present = steps.filter((step): step is EvalStepTrace => step !== undefined);
  if (present.length === 0) return undefined;
  if (present.length < steps.length) return AttemptDivergenceReason.Length;
  if (!isSame(present, (step) => `${step.nodeId}#${String(step.visitNumber)}`))
    return AttemptDivergenceReason.NextStep;
  if (!isSame(present, (step) => step.inputHash)) return AttemptDivergenceReason.Input;
  if (!isSame(present, decisionsOf)) return AttemptDivergenceReason.Verdicts;
  if (!isSame(present, toolCallsOf)) return AttemptDivergenceReason.ToolCalls;
  return undefined;
}

/** Where the case's runs part ways; undefined with fewer than two traced runs or none differing. */
export function attemptDivergenceOf(found: EvalCaseReport): AttemptDivergence | undefined {
  const traced = found.runResults.flatMap((result): TracedRun[] =>
    result.trace === undefined
      ? []
      : [{ run: result.run, steps: result.trace.steps, output: result.trace.output }],
  );
  if (traced.length < 2) return undefined;
  const longest = Math.max(...traced.map((each) => each.steps.length));
  for (let index = 0; index < longest; index += 1) {
    const reason = reasonAt(traced.map((each) => each.steps[index]));
    if (reason === undefined) continue;
    // another next node or an end is chosen by the last step the runs shared
    const isChoice =
      reason === AttemptDivergenceReason.NextStep || reason === AttemptDivergenceReason.Length;
    return divergenceAt(traced, isChoice ? index - 1 : index, reason);
  }
  const outputs = new Set(traced.map((each) => JSON.stringify(each.output ?? null)));
  return outputs.size > 1
    ? divergenceAt(traced, longest - 1, AttemptDivergenceReason.Output)
    : undefined;
}

/** The divergence at a step of the first traced run; undefined before its first step. */
function divergenceAt(
  traced: readonly TracedRun[],
  stepIndex: number,
  reason: AttemptDivergenceReason,
): AttemptDivergence | undefined {
  const at = stepIndex < 0 ? undefined : traced[0]?.steps[stepIndex];
  if (at === undefined) return undefined;
  const runs = traced.map((each) => each.run);
  return { nodeId: at.nodeId, visitNumber: at.visitNumber, stepIndex, reason, runs };
}
