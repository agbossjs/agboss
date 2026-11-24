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
   * How long `execute` may run; past it the step fails with `StepError.ActionTimeout`. An action has
   * NO timeout by default (a tool's is 30 s): set one for a call that can hang on a socket.
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
    recordDeclaration(value, declared(NodeKind.Action, options, source, span));
    return value;
  };
}
