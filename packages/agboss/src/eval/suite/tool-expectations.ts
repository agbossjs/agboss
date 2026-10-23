import type { ToolHandlerClass } from "../../components/decorators.js";
import type { PartialValues } from "../../testing/script-types.js";
import type { ToolInputOf } from "../../testing/units/test-tool.js";

/**
 * What a case expects of the run's tool calls (#396), checked by `checkTrajectory()`: tools it must
 * call (with some arguments, `toolCall(Tool, { … })`), tools it must never call, and predicates every
 * call of a tool must satisfy (`toolInvariant(Tool, (input) => …)`) — typed by each tool's input DTO.
 */

/** The arguments of one tool call as a case expects them: a deep partial of the tool's input. */
export type ToolArgumentsOf<TTool extends ToolHandlerClass> = PartialValues<
  ToolInputOf<InstanceType<TTool>>
>;

/** A tool the run must call: some call of it has these arguments (all of them when none). */
export interface ExpectedToolCall<TTool extends ToolHandlerClass = ToolHandlerClass> {
  readonly tool: TTool;
  /** A partial of its input: the keys given must match, the others are not compared. */
  readonly arguments?: ToolArgumentsOf<TTool>;
}

/** A predicate every call of a tool must satisfy (a call that breaks it fails the trajectory). */
export interface ToolInvariant<TTool extends ToolHandlerClass = ToolHandlerClass> {
  readonly tool: TTool;
  /** Whether one call's input satisfies the invariant. */
  readonly holds: (input: ToolInputOf<InstanceType<TTool>>) => boolean;
}

/** `evalCase({ tools })`: what the run's tool calls must and must not be. */
export interface EvalToolExpectations {
  /** Tools the run must call, each with the arguments given. */
  readonly required?: readonly ExpectedToolCall[];
  /** Tools the run must never call. */
  readonly forbidden?: readonly ToolHandlerClass[];
  /** Predicates every call of their tool must satisfy. */
  readonly invariants?: readonly ToolInvariant[];
}

/** A tool the run must call, optionally with some of its arguments (typed by its input DTO). */
export function toolCall<const TTool extends ToolHandlerClass>(
  tool: TTool,
  args?: ToolArgumentsOf<TTool>,
): ExpectedToolCall<TTool> {
  return Object.freeze(args === undefined ? { tool } : { tool, arguments: args });
}

/** A predicate every call of `tool` must satisfy, on its input (typed by its input DTO). */
export const toolInvariant = <const TTool extends ToolHandlerClass>(
  tool: TTool,
  holds: (input: ToolInputOf<InstanceType<TTool>>) => boolean,
): ToolInvariant<TTool> => Object.freeze({ tool, holds });
