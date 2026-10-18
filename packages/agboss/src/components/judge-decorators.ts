import type { BaseMessageLike } from "@langchain/core/messages";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../llm/decisions.js";
import { recordComponent } from "./metadata.js";
import type { ResolvedAll, Token } from "./injection.js";

/** `@Judge` — a quality gate of an agent's reply, with the model it judges with. */
export interface JudgeMeta {
  /** Unique in the workflow: the judge's settings key (`judges.<name>`) and its cost caller (`judge:<name>`). */
  readonly name: string;
  /**
   * The judge's own model, required (`judge.no-model`): a chat model (`judgeModel.invoke`) or a
   * decision model such as `openai/gpt-6-luna-decisions` or `typesafe/jev-1.13` (`judgeModel.decide`).
   */
  readonly model: string;
  readonly description?: string;
}

/**
 * The judge's own model (`@Judge({ model })`), through the model gateway: every call is in the
 * run's cost report. Injected through the constructor (`deps: [JudgeModel]`, #280); each call goes
 * to the model of the judge whose `judge()` is running.
 */
export abstract class JudgeModel {
  /** The model id (`@Judge({ model })`). */
  abstract readonly model: string;
  /** One chat call; returns the reply's text. On a decision model: `ModelKindError`. */
  abstract invoke(input: string | readonly BaseMessageLike[]): Promise<string>;
  /**
   * One decision (questions from `Decision.choice / noul / score`), its answers typed by them. On a
   * chat model: `ModelKindError`.
   */
  abstract decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>>;
}

/**
 * What a judge judges (#280: data only, no context — the execution comes through
 * `deps: [ExecutionContext]`, the agent as its `step.component`).
 */
export interface JudgeInput {
  /** The agent's reply. */
  readonly reply: string;
  /** The run's task (the agent's input message). */
  readonly task: string;
  /** Retries so far: 0 for the agent's first reply. */
  readonly attempt: number;
}

/** A judge's verdict: a failed one sends `feedback` back to the agent for its retry. */
export interface JudgeVerdict {
  readonly passed: boolean;
  readonly feedback?: string;
  readonly metrics?: Readonly<Record<string, number | string | boolean>>;
}

/** What a `@Judge` class implements. */
export interface JudgeHandler {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

/**
 * A quality gate of an agent's reply (`@Agent({ judges: [...], maxRetries })`), created by the
 * workflow's container with its `deps`; its model calls go through the model gateway.
 */
export function Judge<const D extends readonly Token[] = []>(
  options: JudgeMeta & { readonly deps?: D },
) {
  return <C extends new (...args: ResolvedAll<D>) => JudgeHandler>(value: C): C => {
    recordComponent(value, { kind: "judge", meta: { ...options, deps: options.deps ?? [] } });
    return value;
  };
}
