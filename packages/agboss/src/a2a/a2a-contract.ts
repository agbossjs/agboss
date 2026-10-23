import type { DtoClass } from "../dto/types.js";
import type { Usd } from "../units/index.js";
import type { A2ATarget } from "./a2a-decorator.js";

/**
 * What an `A2AClient` calls (#398 PR 3): the receiver's application and start, what `execute`
 * sends and gets back, and the price of one call — `@A2AAgent`'s, or a standalone client's
 * `contract` option.
 */
export interface A2AContract {
  readonly target: A2ATarget;
  readonly input: DtoClass;
  readonly output: DtoClass;
  readonly price?: Usd;
}
