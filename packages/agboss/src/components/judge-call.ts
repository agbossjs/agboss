import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseMessageLike } from "@langchain/core/messages";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../llm/decisions.js";
import { JudgeModel } from "./judge-decorators.js";
import { ComponentError } from "./metadata.js";

/**
 * Which judge is judging now (#280): the agent loop runs each `judge()` with that judge's metered
 * model; the injected `JudgeModel` sends every call to it. One per async context, so judges of
 * parallel agents never mix.
 */
const judging = new AsyncLocalStorage<JudgeModel>();

/** Runs one judge's `judge()` with its model as the current `JudgeModel`. */
export const runJudgeCall = <TResult>(
  model: JudgeModel,
  work: () => Promise<TResult>,
): Promise<TResult> => judging.run(model, work);

/** The injected `JudgeModel`: the model of the judge whose `judge()` runs now. */
export class LiveJudgeModel extends JudgeModel {
  constructor(private readonly consumer: string) {
    super();
    Object.freeze(this);
  }

  get model(): string {
    return this.current("model").model;
  }

  invoke(input: string | readonly BaseMessageLike[]): Promise<string> {
    return this.current("invoke").invoke(input);
  }

  decide<const Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<AnswersOf<Q>> {
    return this.current("decide").decide(request);
  }

  private current(member: string): JudgeModel {
    const model = judging.getStore();
    if (model === undefined) {
      throw new ComponentError({
        message: `[judge.model-outside-judge] ${this.consumer} used judgeModel.${member} outside a judge's judge() — inject JudgeModel only into a @Judge and call it from judge()`,
      });
    }
    return model;
  }
}
