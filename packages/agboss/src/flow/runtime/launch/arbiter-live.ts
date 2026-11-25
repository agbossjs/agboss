import { ConfigError } from "../../../core/error-families/config-errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelMessage } from "../../../models/messages.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../../../llm/decisions.js";
import { ArbiterModel } from "../../decorators/arbiter.js";

/**
 * The injected `ArbiterModel` (#1283): the model of the arbiter whose `@Arbitrate` method runs now.
 * A module of its own, small: the root loads it (the container resolves it), the metering behind it
 * (`arbiter-call.ts`) loads with the runtime.
 */

/** Which arbiter's model is current: one per async context, so arbiters of parallel branches never mix. */
const arbiting = new AsyncLocalStorage<ArbiterModel>();

/** Runs one `@Arbitrate` method — sync or async — with its arbiter's model as the current `ArbiterModel`. */
export const runArbiterCall = <TResult>(
  model: ArbiterModel,
  work: () => TResult | Promise<TResult>,
): Promise<TResult> => arbiting.run(model, async () => work());

/** The injected `ArbiterModel`: the model of the arbiter whose `@Arbitrate` method runs now. */
export class LiveArbiterModel extends ArbiterModel {
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

  private current(member: string): ArbiterModel {
    const model = arbiting.getStore();
    if (model === undefined) {
      throw new ConfigError.Component({
        message: `[arbiter.model-outside-arbiter] ${this.consumer} used arbiterModel.${member} outside an @Arbitrate method — inject ArbiterModel only into an @Arbiter and call it from its @Arbitrate methods`,
      });
    }
    return model;
  }
}
