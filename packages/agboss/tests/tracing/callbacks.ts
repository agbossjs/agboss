import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";

/**
 * Calls a callback of `handler` the way LangChain's callback manager does — by name, with the
 * arguments it passes (its typings list them in another order for chains) — so a test hands the
 * emitter exactly what a run would.
 */
export function call(handler: BaseCallbackHandler, method: string, ...args: unknown[]): unknown {
  const callback: unknown = Reflect.get(handler, method);
  return typeof callback === "function" ? Reflect.apply(callback, handler, args) : undefined;
}
