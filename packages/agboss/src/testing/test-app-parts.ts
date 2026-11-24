import { executionControlOf, type ExecutionControl } from "../app/execution-control.js";
import type { AnyTenantApp } from "../app/types.js";
import type { Class, Resolved, Token } from "../components/injection.js";
import { definedOf } from "../infrastructure/clock.js";
import type { TestApp } from "./test-app.js";

/** `resolve` and `get`: what the built app's container holds for a token (a class, a value, an env dictionary). */
export const resolvingOf = (readyApp: () => AnyTenantApp): Pick<TestApp, "resolve" | "get"> => ({
  resolve: (token) => readyApp().resolve(token),
  get: <TToken extends Token>(token: TToken): Resolved<TToken> =>
    readyApp().resolve(token as Class) as Resolved<TToken>,
});

/** The built app's execution control (#807), reached once the app is built. */
export function forwardedControlOf(readyApp: () => AnyTenantApp): ExecutionControl {
  const control = (): ExecutionControl =>
    definedOf(executionControlOf(readyApp()), "a built application has its execution control");
  return {
    cancelExecution: (request) => control().cancelExecution(request),
    executionStateOf: (tree) => control().executionStateOf(tree),
    claimExecutionId: (identity) => control().claimExecutionId(identity),
  };
}
