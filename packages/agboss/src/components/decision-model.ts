import { assertOutsideRunOnce } from "../app/idempotency-scope.js";
import { currentFrame } from "../flow/context/frame.js";
import { decisionSpendOf } from "../finops/failed-decision.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../llm/decisions.js";
import type { DecisionOutcome } from "../llm/decision-response.js";
import type { Class } from "./injection.js";
import { SpendOutsideStepError } from "./spend-recorder.js";

/**
 * The injectable `DecisionModel` (#1313): `deps: [DecisionModel]` in a `@Tool`, an `@Action` or a
 * service of theirs, then `await this.decisions.decide({ state, questions })` — answers to closed
 * questions (a batch of `Decision` scoring) from a decisions model, with the cost of the call in the
 * step's (the tool call's) spend: the execution's cost report, its budgets and the ledger, as the
 * spend of any other model call. It replaces the 0.1.0 `ROUTER_FACTORY` for a project's own decisions.
 */

/** Which model answers: both optional — the cascade (`modelProvider` of the workflow and the application) gives the rest. */
export interface DecisionModelOptions {
  /** A model name or a role of the provider (`"fast"`); default the provider's own default. */
  readonly model?: string;
  /** The `@ModelProvider` class that serves it; default the workflow's, else the application's. */
  readonly modelProvider?: Class;
}

/**
 * Asks a decisions model closed questions (`deps: [DecisionModel]`). The call is checked against the
 * execution's budgets first (an exhausted budget stops it before any request) and stops with the
 * execution's cancel; what it spent is recorded in the step's usage even when the answer cannot be
 * used (a billed but invalid answer is still spent).
 */
export abstract class DecisionModel {
  abstract decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
    options?: DecisionModelOptions,
  ): Promise<AnswersOf<Q>>;
}

/** One call as the application's decision service takes it: who asks and what, under which cost caller. */
export interface DecisionCall {
  readonly caller: string;
  readonly options: DecisionModelOptions;
  readonly request: DecisionRequest;
}

/** What answers a call: the model resolved through the cascade, the gateway, the cost in the outcome. */
export type DecisionService = (call: DecisionCall) => Promise<DecisionOutcome>;

/** The cost caller of a service's decisions: `decision:<consumer>`. */
const decisionCaller = (consumer: string): string => `decision:${consumer}`;

/** The injected `DecisionModel`: one per consumer, spending into the frame of the current step. */
export class LiveDecisionModel extends DecisionModel {
  constructor(
    private readonly consumer: string,
    private readonly service: DecisionService | undefined,
  ) {
    super();
    Object.freeze(this);
  }

  async decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
    options: DecisionModelOptions = {},
  ): Promise<AnswersOf<Q>> {
    // a store may run a `runOnce`'s `execute` again: a decision paid in it would be paid twice
    assertOutsideRunOnce(`DecisionModel.decide of ${this.consumer}`);
    const frame = currentFrame();
    const report = frame?.isClosed() === false ? frame.services.reportUsage : undefined;
    if (frame === undefined || report === undefined) {
      throw new SpendOutsideStepError({
        message: `[spend.outside-step] ${this.consumer} asked a decision outside a step or a tool call — ask it while the step (or the tool call) runs, so its cost has an execution to be billed to`,
      });
    }
    if (this.service === undefined) {
      throw new TypeError(`${this.consumer}: this application has no model gateway for decisions`);
    }
    // an exhausted budget (or a cancel) aborts the execution's signal: no request is made after it
    const { signal } = frame.execution;
    if (signal.aborted) throw signal.reason;
    const outcome = await this.service({
      caller: decisionCaller(this.consumer),
      options,
      request,
    }).catch((error: unknown) => {
      const billed = decisionSpendOf(error);
      if (billed !== undefined) report(billed); // an answer it billed and could not use (#1399)
      throw error;
    });
    report(outcome.usage);
    // validated against these very questions by the gateway: each id answered with its own type
    return outcome.answers as AnswersOf<Q>;
  }
}

/** The model and provider (its `name`) a call goes to. */
export interface DecisionTarget {
  readonly model: string;
  readonly modelProvider?: string;
}

/** A workflow's resolution of a call's options through its model cascade (#1313). */
export type DecisionTargetOf = (options: DecisionModelOptions) => DecisionTarget;
