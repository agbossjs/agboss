import type { ToolHandler } from "../../components/decorators.js";
import type { Class } from "../../components/injection.js";
import type { PartialValues } from "../../testing/script-types.js";
import type { ToolInputOf } from "../../tools/index.js";

/**
 * What a case expects of the run's tool calls (#396), checked before the judges: tools it must
 * call (with some arguments, `toolCall(Tool, { … })`), tools it must never call, and predicates every
 * call of a tool must satisfy (`toolInvariant(Tool, (input) => …)`) — typed by each tool's input DTO.
 */

/** The input of one tool call as a case expects it: a deep partial of the tool's input. */
export type ToolInputPartialOf<TTool extends Class<ToolHandler<never, unknown>>> = PartialValues<
  ToolInputOf<InstanceType<TTool>>
>;

/** A tool the run must call: some call of it has this input (any call when none). */
export interface ExpectedToolCall<
  TTool extends Class<ToolHandler<never, unknown>> = Class<ToolHandler<never, unknown>>,
> {
  readonly tool: TTool;
  /** A partial of its input: the keys given must match, the others are not compared. */
  readonly input?: ToolInputPartialOf<TTool>;
}

/** A predicate every call of a tool must satisfy (a call that breaks it fails the trajectory). */
export interface ToolInvariant<
  TTool extends Class<ToolHandler<never, unknown>> = Class<ToolHandler<never, unknown>>,
> {
  readonly tool: TTool;
  /** Whether one call's input satisfies the invariant. */
  readonly holds: (input: ToolInputOf<InstanceType<TTool>>) => boolean;
}

/** `evalCase({ tools })`: what the run's tool calls must and must not be. */
export interface EvalToolExpectations {
  /** Tools the run must call, each with the input given. */
  readonly required?: readonly ExpectedToolCall[];
  /** Tools the run must never call. */
  readonly forbidden?: readonly Class<ToolHandler<never, unknown>>[];
  /** Predicates every call of their tool must satisfy. */
  readonly invariants?: readonly ToolInvariant[];
}

/** A tool the run must call, optionally with some of its input (typed by its input DTO). */
export function toolCall<const TTool extends Class<ToolHandler<never, unknown>>>(
  tool: TTool,
  input?: ToolInputPartialOf<TTool>,
): ExpectedToolCall<TTool> {
  return Object.freeze(input === undefined ? { tool } : { tool, input });
}

/** A predicate every call of `tool` must satisfy, on its input (typed by its input DTO). */
export const toolInvariant = <const TTool extends Class<ToolHandler<never, unknown>>>(
  tool: TTool,
  holds: (input: ToolInputOf<InstanceType<TTool>>) => boolean,
): ToolInvariant<TTool> => Object.freeze({ tool, holds });
