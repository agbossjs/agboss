import type { ErrorRecord } from "../../core/error-record.js";
import type { GuardrailSide } from "../../components/policy-decorators.js";
import type { JudgeMetrics } from "../../components/judge-decorators.js";
import { buildCostReport, type CostReport, type UsageRecord } from "../../finops/usage.js";
import { versionOf } from "../../terns/index.js";
import type { StepRecord } from "../context/execution-context.js";
import { bareRecordOf, ComponentKind, type ComponentRecord } from "./records.js";

/**
 * The steps of an execution (#395 C3): one record per visit of a node, in the order the visits
 * ended — which step it was, a hash of what it read, what its judges and guardrails decided, what it
 * spent and when — `result.record.steps`, masked like the rest of the record.
 */

/** One judge's verdict on one reply of an agent's visit. */
export interface JudgeVerdictRecord {
  readonly judge: ComponentRecord;
  /** The reply it judged: the agent's retries before it, 0 for its first reply. */
  readonly attempt: number;
  readonly passed: boolean;
  /** Why it failed the reply; `undefined` when it passed. */
  readonly reason?: string;
  readonly metrics?: JudgeMetrics;
}

/** One guardrail's decision on what a model of the visit read or answered. */
export interface GuardrailDecisionRecord {
  readonly guardrail: ComponentRecord;
  readonly side: GuardrailSide;
  readonly isBlocked: boolean;
  /** P(yes) of its question; a code guardrail's is 0 for a pass, 1 for a block. */
  readonly probability: number;
}

/** A guardrail's outcome as the step's record keeps it. */
export const guardrailDecisionOf = (
  name: string,
  side: GuardrailSide,
  outcome: { readonly isBlocked: boolean; readonly probability: number },
): GuardrailDecisionRecord => ({
  guardrail: bareRecordOf(name, ComponentKind.Guardrail),
  side,
  isBlocked: outcome.isBlocked,
  probability: outcome.probability,
});

/** One visit of a node, as the execution record keeps it. */
export interface ExecutionStepRecord {
  /** The visit: its component, node, visit, copy and item. */
  readonly step: StepRecord;
  /**
   * A stable hash of what the visit read — its input fields, hashed the way a recorded model call
   * is matched (`versionOf` of their stable JSON): one input, one hash, on every machine.
   */
  readonly inputHash: string;
  /**
   * What the visit decided, the same for the same decision on every machine (#401 PR 5, S2 Q4):
   * `route:<node>` for a router's choice, `launch:<node>,…` for the routes it launched,
   * `variant:<class>` for an answer of a `oneOf` output, else `answer:<hash>` of its value; none for
   * a visit that gave nothing (a failure, a finish). Never a value itself: an answer is only its
   * hash, a route and a variant are component and class names. What the Mesh Hub's radar counts.
   */
  readonly decision?: string;
  /** Its agent's judges' verdicts, in the order they judged; empty for any other step. */
  readonly judgeVerdicts: readonly JudgeVerdictRecord[];
  /** Its guardrails' decisions, in the order they decided. */
  readonly guardrailDecisions: readonly GuardrailDecisionRecord[];
  /** What the visit spent: its model calls, its tools' and services' spend. */
  readonly spend: CostReport;
  /** When it started and ended (ISO 8601, the application's `Clock`). */
  readonly startedAt: string;
  readonly endedAt: string;
  /** The failure an `.onError` side path took; `undefined` for a visit that succeeded. */
  readonly error?: ErrorRecord;
}

/** What a visit's step record is made of. */
export interface VisitedStep {
  readonly step: StepRecord;
  readonly input: unknown;
  readonly decision?: string;
  readonly usage: readonly UsageRecord[];
  readonly judgeVerdicts?: readonly JudgeVerdictRecord[] | undefined;
  readonly guardrailDecisions?: readonly GuardrailDecisionRecord[] | undefined;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly error?: ErrorRecord;
}

/** The record of one visit. */
export const executionStepRecordOf = (visited: VisitedStep): ExecutionStepRecord => ({
  step: visited.step,
  inputHash: versionOf(visited.input ?? null),
  ...(visited.decision === undefined ? {} : { decision: visited.decision }),
  judgeVerdicts: [...(visited.judgeVerdicts ?? [])],
  guardrailDecisions: [...(visited.guardrailDecisions ?? [])],
  spend: buildCostReport(visited.usage),
  startedAt: visited.startedAt.toISOString(),
  endedAt: visited.endedAt.toISOString(),
  ...(visited.error === undefined ? {} : { error: visited.error }),
});
