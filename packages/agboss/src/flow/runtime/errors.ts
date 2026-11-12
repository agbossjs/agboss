import { isGraphInterrupt } from "@langchain/langgraph";
import {
  AGBossError,
  ExecutionCancelledError,
  type MessageErrorOptions,
} from "../../core/errors.js";
import type { UsageRecord } from "../../finops/usage.js";
import {
  AgentFailedError,
  PaidStepError,
  StepFailedError,
  stepCoordinatesOf,
} from "../../graph/errors.js";
import { LimitExceededError } from "../../graph/limits.js";
import { ComponentKind, type ComponentRecord } from "./records.js";

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The errors of the v2 runtime (#272, #261 Q42, S9, S22): each a plain record in state when an
 * `.onError` catches it, so it holds after a resume.
 */

/** What a visits limit error takes (#906). */
export interface VisitsLimitExceededErrorOptions {
  /** The router or the agent (no class: the error is kept on a plain record). */
  readonly component: ComponentRecord;
  readonly maxVisits: number;
  readonly path: readonly string[];
  readonly spentUsd: number;
  readonly cause?: unknown;
}

/** A visit past a router's or an agent's `maxVisits` — refused before the node runs (#272 AC14). */
export class VisitsLimitExceededError extends LimitExceededError {
  static override readonly code = "limit.visits" as const;
  declare readonly code: typeof VisitsLimitExceededError.code;
  override name = "VisitsLimitExceededError";
  /** The router or the agent (no class: the error is kept on a plain record). */
  readonly component: ComponentRecord;
  readonly nodeId: string;
  readonly maxVisits: number;
  readonly visits: number;

  constructor(options: VisitsLimitExceededErrorOptions) {
    const { component, maxVisits, path, spentUsd, cause } = options;
    const nodeId = component.name;
    const visits = maxVisits + 1;
    super({
      key: `${nodeId}.maxVisits`,
      limit: maxVisits,
      actual: visits,
      path,
      spentUsd,
      cause,
      message: `${nodeId} was visited ${String(visits)} times; its maxVisits is ${String(maxVisits)}`,
      details: { component, nodeId, maxVisits, visits },
    });
    this.component = component;
    this.nodeId = nodeId;
    this.maxVisits = maxVisits;
    this.visits = visits;
  }
}

/** What an invalid-answer error takes (#906): `cause` is what was wrong with the last answer. */
export interface AgentAnswerInvalidErrorOptions {
  readonly agent: string;
  readonly attempts: number;
  readonly usage: readonly UsageRecord[];
  /** What was wrong with the last answer (a text, or the error that refused it). */
  readonly cause?: unknown;
}

/** An agent's answers stayed invalid after its retries (S9): 3 attempts, then this. */
export class AgentAnswerInvalidError extends AgentFailedError {
  static override readonly code = "step.agent.invalid-answer" as const;
  declare readonly code: typeof AgentAnswerInvalidError.code;
  override name = "AgentAnswerInvalidError";
  readonly attempts: number;

  constructor(options: AgentAnswerInvalidErrorOptions) {
    const { agent, attempts, usage, cause } = options;
    super({
      agent,
      usage,
      cause,
      message: `Agent "${agent}" failed: no valid answer after ${String(attempts)} attempts: ${describe(cause)}`,
      details: { attempts },
    });
    this.attempts = attempts;
  }
}

/** What an action's failure takes (#906): the action and what it threw. */
export interface ActionFailedErrorOptions {
  /** The action's `name`. */
  readonly action: string;
  /** What the action threw. */
  readonly cause?: unknown;
}

/**
 * An action threw (S22): a `StepFailedError` naming its step (an item's index too), the original
 * error as the `cause`, so `.onError` can take either.
 */
export class ActionFailedError extends StepFailedError {
  static override readonly code = "step.action" as const;
  declare readonly code: typeof ActionFailedError.code;
  override name = "ActionFailedError";
  /** The action that failed: its `name`. */
  readonly action: string;

  constructor(options: ActionFailedErrorOptions) {
    const { action, cause } = options;
    super({
      message: `Action "${action}" failed: ${describe(cause)}`,
      usage: [],
      cause,
      ...stepCoordinatesOf(action, ComponentKind.Action),
    });
    this.action = action;
  }
}

/**
 * A question role's step (#659) whose channel's `send` threw (not cancelled): the step's failure,
 * the channel's error as `cause` — `.onError(E, …)` right after `.toQuestion(Role)` takes it by
 * class or cause chain.
 */
export class QuestionFailedError extends StepFailedError {
  static override readonly code = "step.question" as const;
  declare readonly code: typeof QuestionFailedError.code;
  override name = "QuestionFailedError";
  /** The question step that failed: its node (the role's name). */
  readonly question: string;

  constructor(options: QuestionFailedErrorOptions) {
    const { question, cause } = options;
    super({
      message: `Question "${question}" failed: ${describe(cause)}`,
      usage: [],
      cause,
      ...stepCoordinatesOf(question, ComponentKind.Question),
      details: { question },
    });
    this.question = question;
  }
}

/** What a `QuestionFailedError` names. */
export interface QuestionFailedErrorOptions {
  /** The question step that failed: its node (the role's name). */
  readonly question: string;
  /** What the channel's `send` threw, or why its decision was refused. */
  readonly cause?: unknown;
}

/**
 * What a step's code may throw that is not its failure (S21, S22): a limit, a cancel or a pause —
 * passed on as it is, never wrapped in the step's error.
 */
export const passesThrough = (error: unknown): boolean =>
  isGraphInterrupt(error) ||
  error instanceof LimitExceededError ||
  error instanceof ExecutionCancelledError;

/** What a guardrail that blocked takes (#906): the guard, its refusal, the spend and how sure it was. */
export interface GuardrailBlockedErrorOptions {
  /** The guardrail's `name`. */
  readonly guard: string;
  /** What the guardrail's refusal says — the text to send instead. */
  readonly refusal: string;
  readonly usage: readonly UsageRecord[];
  /** P(yes) of its model: the text is what its question asks about. */
  readonly probability: number;
  readonly threshold: number;
  readonly cause?: unknown;
}

/**
 * A guardrail blocked (#120): its model was at least `threshold` sure (`key` names that setting,
 * `guardrails.<name>.threshold`). The execution fails; `refusal` is the text to send instead.
 */
export class GuardrailBlockedError extends PaidStepError {
  static override readonly code = "guardrail.blocked" as const;
  declare readonly code: typeof GuardrailBlockedError.code;
  override name = "GuardrailBlockedError";
  /** The guardrail's `name`. */
  readonly guard: string;
  /** What the guardrail's refusal says — the text to send instead. */
  readonly refusal: string;
  /** The setting that decided: `guardrails.<name>.threshold`. */
  readonly key: string;
  readonly probability: number;
  readonly threshold: number;

  constructor(options: GuardrailBlockedErrorOptions) {
    const { guard, refusal, usage, probability, threshold, cause } = options;
    const key = `guardrails.${guard}.threshold`;
    super({
      message: `Guardrail "${guard}" blocked the execution: ${refusal}`,
      usage,
      cause,
      details: { guard, refusal, key, probability, threshold },
    });
    this.guard = guard;
    this.refusal = refusal;
    this.key = key;
    this.probability = probability;
    this.threshold = threshold;
  }
}

/** A node returned a value its `output` does not allow (an action, a finish). */
export class OutputInvalidError extends AGBossError {
  static override readonly code = "step.output-invalid" as const;
  declare readonly code: typeof OutputInvalidError.code;
  override name = "OutputInvalidError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}
