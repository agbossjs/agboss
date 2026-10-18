import { isGraphInterrupt } from "@langchain/langgraph";
import { AGBossError, WorkflowCancelledError } from "../../core/errors.js";
import type { UsageRecord } from "../../finops/usage.js";
import {
  AgentFailedError,
  PaidStepError,
  StepFailedError,
  stepCoordinatesOf,
} from "../../graph/errors.js";
import { LimitExceededError } from "../../graph/limits.js";
import type { ComponentRecord } from "./records.js";

/**
 * The errors of the v2 runtime (#272, #261 Q42, S9, S22): each a plain record in state when an
 * `.onError` catches it, so it holds after a resume.
 */

/** A visit past a router's or an agent's `maxVisits` — refused before the node runs (#272 AC14). */
export class VisitsLimitExceededError extends LimitExceededError {
  static override readonly code: string = "limit.visits";
  override name = "VisitsLimitExceededError";
  /** The router or the agent (no class: the error is kept on a plain record). */
  readonly component: ComponentRecord;
  readonly nodeId: string;
  readonly maxVisits: number;
  readonly visits: number;

  constructor(nodeId: string, maxVisits: number, path: readonly string[], spentUsd: number) {
    const visits = maxVisits + 1;
    super({ key: `${nodeId}.maxVisits`, limit: maxVisits, actual: visits }, path, spentUsd, [], {
      message: `${nodeId} was visited ${String(visits)} times; its maxVisits is ${String(maxVisits)}`,
      details: { component: { name: nodeId }, nodeId, maxVisits, visits },
    });
    this.component = { name: nodeId };
    this.nodeId = nodeId;
    this.maxVisits = maxVisits;
    this.visits = visits;
  }
}

/** An agent's answers stayed invalid after its retries (S9): 3 attempts, then this. */
export class AgentAnswerInvalidError extends AgentFailedError {
  static override readonly code: string = "step.agent.invalid-answer";
  override name = "AgentAnswerInvalidError";
  readonly attempts: number;

  constructor(agent: string, attempts: number, problem: string, usage: readonly UsageRecord[]) {
    super(agent, usage, `no valid answer after ${String(attempts)} attempts: ${problem}`, {
      attempts,
    });
    this.attempts = attempts;
  }
}

/**
 * An action threw (S22): a `StepFailedError` naming its step (an item's index too), the original
 * error as the `cause`, so `.onError` can take either.
 */
export class ActionFailedError extends StepFailedError {
  static override readonly code: string = "step.action";
  override name = "ActionFailedError";

  constructor(action: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Action "${action}" failed: ${reason}`, [], cause, stepCoordinatesOf(action));
  }
}

/**
 * What a step's code may throw that is not its failure (S21, S22): a limit, a cancel or a pause —
 * passed on as it is, never wrapped in the step's error.
 */
export const passesThrough = (error: unknown): boolean =>
  isGraphInterrupt(error) ||
  error instanceof LimitExceededError ||
  error instanceof WorkflowCancelledError;

/** A guard tripped on the execution's input or output (#120 `GuardrailBlockedError`). */
export class GuardrailBlockedError extends PaidStepError {
  static override readonly code: string = "guardrail.blocked";
  override name = "GuardrailBlockedError";
  readonly guard: string;
  /** What the guard's `refusal` says — the text to send instead. */
  readonly refusal: string;

  constructor(guard: string, refusal: string, usage: readonly UsageRecord[]) {
    super(`Guard "${guard}" blocked the execution: ${refusal}`, usage, undefined, {
      guard,
      refusal,
    });
    this.guard = guard;
    this.refusal = refusal;
  }
}

/** A node returned a value its `output` does not allow (an action, a finish). */
export class OutputInvalidError extends AGBossError {
  static override readonly code: string = "step.output-invalid";
  override name = "OutputInvalidError";
}
