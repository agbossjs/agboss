import type { Assertion } from "vitest";
import type { DtoClass } from "../dto/types.js";
import type { ActionScript } from "./action-script.js";
import type { WorkflowMatchers } from "./matchers.js";
import type { ModelScript } from "./model-script.js";
import type { DeepPartial, InputMatcherOf, ReturnedCheckOf } from "./script-types.js";

/**
 * The call matchers of `mockLlm(X)` and `mockAction(A)` (#262 AC9), typed by the component's
 * generated types: Vitest's names, its mock matchers of the same names on anything else.
 */
export interface CallMatchers<TSelf> {
  /** A call's input matched this partial (the matcher of `when(…)`): `PartialValues<InputOf<X>>`. */
  toHaveBeenCalledWith(partial: InputMatcherOf<TSelf>): void;
  /** How many calls: model calls of `mockLlm(X)`, executions of `mockAction(A)`. */
  toHaveBeenCalledTimes(times: number): void;
  /** It returned a value of this class (and, given, with these fields; a list output: the list). */
  toHaveReturned<TDto extends DtoClass>(
    dto: TDto & ReturnedCheckOf<TSelf, TDto>,
    partial?: DeepPartial<InstanceType<TDto>> | readonly DeepPartial<InstanceType<TDto>>[],
  ): void;
}

/** `expect(mockLlm(X))`: Vitest's assertion with the call matchers typed for X. */
export type CallAssertion<TReceived, TSelf> = Omit<
  Assertion<TReceived>,
  keyof CallMatchers<TSelf> | "not"
> &
  CallMatchers<TSelf> & {
    readonly not: Omit<Assertion<TReceived>, keyof CallMatchers<TSelf>> & CallMatchers<TSelf>;
  };

/** `expect(result).toFollowPath([…])`, the other workflow matchers and the call matchers, typed. */
declare module "vitest" {
  interface Matchers<T> {
    toFollowPath: WorkflowMatchers<T>["toFollowPath"];
    toFinishWith: WorkflowMatchers<T>["toFinishWith"];
    toHavePausedAt: WorkflowMatchers<T>["toHavePausedAt"];
    toFailWith: WorkflowMatchers<T>["toFailWith"];
    toHaveCalledTools: WorkflowMatchers<T>["toHaveCalledTools"];
    toHaveBeenAskedWith: WorkflowMatchers<T>["toHaveBeenAskedWith"];
  }

  interface ExpectStatic {
    <TSelf>(actual: ModelScript<TSelf>, message?: string): CallAssertion<ModelScript<TSelf>, TSelf>;
    <TSelf>(
      actual: ActionScript<TSelf>,
      message?: string,
    ): CallAssertion<ActionScript<TSelf>, TSelf>;
  }
}
