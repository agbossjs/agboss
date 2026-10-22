import { callerFile } from "../../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../../components/injection.js";
import { NodeKind } from "../ast.js";
import type { OutputShape } from "../dto-wrappers.js";
import { declared, recordDeclaration, type InputFields } from "./declaration.js";

/**
 * `@Action` (was `@WorkflowAction`) — a code node: `implements ActionHandler<Self>`,
 * `execute(input: InputOf<Self>)`. Without `output` it is done for its side effect
 * (`Promise<void>`) and the flow goes straight to the next `.to…` (no `.returns`).
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
  readonly compensateWith?: ActionClass;
  /**
   * The `@Action` after which nothing undoes it any more (#339); without it, a finish commits it.
   * Every path from it to a finish runs this one or its undo (`[flow.uncommitted-action]`).
   */
  readonly committedBy?: ActionClass;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
}

/**
 * What an action's class has: `execute(input)` (`implements ActionHandler<Self>`); the execution
 * comes through `deps: [ExecutionContext]` (#280).
 */
export interface ExecuteMethod {
  execute(input: never): Promise<unknown>;
}

/** An `@Action` class: what `compensateWith` and `committedBy` name (#339). */
export type ActionClass = Class<ExecuteMethod>;

export function Action<const TDeps extends readonly Token[] = []>(options: ActionOptions<TDeps>) {
  const source = callerFile();
  return <TClass extends new (...args: ResolvedAll<TDeps>) => ExecuteMethod>(
    value: TClass,
  ): TClass => {
    recordDeclaration(value, declared(NodeKind.Action, options, source));
    return value;
  };
}
