import { ConfigError } from "../core/error-families/config-errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelMessage } from "../models/messages.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../llm/decisions.js";
import { JudgeModel } from "./judge-decorators.js";

/**
 * Which judge is judging now (#280): the agent loop runs each `judge()` with that judge's metered
 * model; the injected `JudgeModel` sends every call to it. One per async context, so judges of
 * parallel agents never mix.
 */
const judging = new AsyncLocalStorage<JudgeModel>();

/**
 * Runs one judge's `judge()` — sync or async — with its model as the current `JudgeModel`. A sync
 * throw is a rejection, so the loop handles both alike.
 */
export const runJudgeCall = <TResult>(
  model: JudgeModel,
  work: () => TResult | Promise<TResult>,
): Promise<TResult> => judging.run(model, async () => work());

/** The injected `JudgeModel`: the model of the judge whose `judge()` runs now. */
export class LiveJudgeModel extends JudgeModel {
  constructor(private readonly consumer: string) {
    super();
    Object.freeze(this);
  }

  get model(): string {
    return this.current("model").model;
  }

  invoke(input: string | readonly ModelMessage[]): Promise<string> {
    return this.current("invoke").invoke(input);
  }

  decide<const Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<AnswersOf<Q>> {
    return this.current("decide").decide(request);
  }

  private current(member: string): JudgeModel {
    const model = judging.getStore();
    if (model === undefined) {
      throw new ConfigError.Component({
        message: `[judge.model-outside-judge] ${this.consumer} used judgeModel.${member} outside a judge's judge() — inject JudgeModel only into a @Judge and call it from judge()`,
      });
    }
    return model;
  }
}
