import { recordOptionKeys } from "../../components/option-keys.js";
import { ACTION_KEYS } from "../../components/decorator-options.js";
import { callerFile } from "../../components/call-site.js";
import { captureCallSite } from "../../core/diagnostics/source-span.js";
import type { Class, ResolvedAll, Token } from "../../components/injection.js";
import { NodeKind } from "../ast.js";
import type { Milliseconds } from "../../units/index.js";
import type { OutputShape } from "../dto-wrappers.js";
import { declared, recordDeclaration, type InputFields } from "./declaration.js";

/**
 * `@Action` (was `@WorkflowAction`) — a code node: `execute(input: InputOf<Self>)`, sync or async
 * (a pure data mapping returns its value; no `input` declared: `execute()`). Without `output` it is
 * done for its side effect and the flow goes straight to the next `.to…`. `implements
 * ActionHandler<Self>` is optional: it only checks the signature.
 */
export interface ActionOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Ends with `-action` (`send-offer-action`). */
  readonly name: string;
  readonly description: string;
  readonly input?: InputFields;
  /** What it returns; what the values are about is said in the flow (#299). */
  readonly output?: OutputShape;
  /**
   * The `@Action` that undoes it (#339): it reads only what the path holds right after this one
   * (`[action.invalid-compensator-input]`), is no model call and undoes nothing itself. A side path
   * after it that ends at a finish runs it, newest first (`[flow.uncompensated-action]`).
   */
  readonly compensateWith?: Class<ExecuteMethod>;
  /**
   * The `@Action` after which nothing undoes it any more (#339); without it, a finish commits it.
   * Every path from it to a finish runs this one or its undo (`[flow.uncommitted-action]`).
   */
  readonly committedBy?: Class<ExecuteMethod>;
  /**
   * How long `execute` may run. An action has NO timeout by default (a tool's is 30 s): set one for
   * a call that can hang on a socket.
   *
   * A timed-out action may STILL FINISH: the framework cannot stop your code, only stop waiting for
   * it. So `execute` must honour `executionContext.signal` (inject `ExecutionContext`): it aborts at
   * the timeout, on a cancel and when the lease is lost — pass it to `fetch` and to your client.
   * Past the timeout the outcome is UNKNOWN, not failed:
   * - the step fails with `StepError.ActionOutcomeUnknown`: its effect may have happened, so
   *   nothing retries or undoes it — settle it in the flow's `.onError` or by an operator;
   * - retrying is the flow's explicit choice (`.onError`); only an effect through `Idempotency`
   *   (`runOnce`, `sendOnce`) is safe to repeat, the key recognises it; a raw effect (a direct
   *   HTTP charge) runs again;
   * - a write the orphaned `execute` then attempts through the framework (`Idempotency`, the fence)
   *   is refused; a write to your own store is yours to guard with the signal and a key.
   */
  readonly timeout?: Milliseconds;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
}

/**
 * What an action's class has: `execute(input)` — sync or async, or `execute()` when it takes no input;
 * the execution comes through `deps: [ExecutionContext]` (#280).
 */
export interface ExecuteMethod {
  execute(input: never): unknown;
}

export function Action<const TDeps extends readonly Token[] = []>(options: ActionOptions<TDeps>) {
  const source = callerFile();
  const span = captureCallSite();
  return <TClass extends new (...args: ResolvedAll<TDeps>) => ExecuteMethod>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "Action", options, ACTION_KEYS);
    recordDeclaration(value, declared(NodeKind.Action, options, source, span));
    return value;
  };
}
