import type { Class } from "../components/injection.js";
import type { ComponentRecord } from "../flow/runtime/records.js";

/**
 * A tool interceptor's contract (#384, #1295): a `@ToolInterceptor` class decides with
 * `@BeforeTool(Tool)` methods (and `beforeAnyTool(call)` for every tool) through
 * `ToolCallDecision.allow()` / `.allow({ input })` / `.reply(message)` / `.block(reason)`, and gives
 * the result the model reads with `@AfterTool(Tool)` methods (and `afterAnyTool(call)`). Small and
 * import-light: part of the root entry.
 */

/** What a decision does with a call (internal: a project reads a decision through `toEqual`). */
export enum ToolCallOutcome {
  Allow = "allow",
  Reply = "reply",
  Block = "block",
}

/** What the framework reads of a decision; set by the class's static block. */
interface DecisionReaders {
  readonly outcome: (decision: ToolCallDecision<unknown>) => ToolCallOutcome;
  readonly text: (decision: ToolCallDecision<unknown>) => string;
  readonly input: (decision: ToolCallDecision<unknown>) => { readonly value: unknown } | undefined;
}
let readers: DecisionReaders;

/**
 * What a `before` hook decided on one call: built only with `allow()`, `allow({ input })`,
 * `reply()`, `block()`. `TInput` is the input a rewriting `allow({ input })` gives; a decision that
 * rewrites nothing is `ToolCallDecision<never>` — what a bare `ToolCallDecision` means.
 */
export class ToolCallDecision<out TInput = never> {
  /** Nominal: a plain object is not a decision. */
  declare private readonly built: true;

  private constructor(
    private readonly outcome: ToolCallOutcome,
    private readonly text: string,
    private readonly rewritten: { readonly value: TInput } | undefined,
  ) {
    Object.freeze(this);
  }

  static {
    readers = {
      outcome: (decision) => decision.outcome,
      text: (decision) => decision.text,
      input: (decision) => decision.rewritten,
    };
  }

  /** The call goes on: the next hook decides, then the tool runs. */
  static allow(): ToolCallDecision;
  /**
   * The call goes on with `input` in place of the model's arguments: validated against the tool's
   * input DTO again, then seen by the next hooks and by the tool.
   */
  static allow<TInput extends object>(options: {
    readonly input: TInput;
  }): ToolCallDecision<TInput>;
  static allow(options?: { readonly input: unknown }): ToolCallDecision<unknown> {
    if (options === undefined) return new ToolCallDecision(ToolCallOutcome.Allow, "", undefined);
    return new ToolCallDecision(ToolCallOutcome.Allow, "", { value: options.input });
  }

  /**
   * The tool is not called and the step goes on: the model reads `message` as the call's text
   * result in its loop (bounded by `maxResultSize`, masked by the PII policies) and may try again.
   */
  static reply(message: string): ToolCallDecision {
    return new ToolCallDecision(ToolCallOutcome.Reply, message, undefined);
  }

  /** The tool is not called and the agent's step fails at once with `ToolBlockedError`. */
  static block(reason: string): ToolCallDecision {
    return new ToolCallDecision(ToolCallOutcome.Block, reason, undefined);
  }
}

/** Whether a value is a decision built by `ToolCallDecision`'s factories. */
export const isToolCallDecision = (value: unknown): value is ToolCallDecision<unknown> =>
  value instanceof ToolCallDecision;

/** A decision's outcome (framework code only). */
export const outcomeOf = (decision: ToolCallDecision<unknown>): ToolCallOutcome =>
  readers.outcome(decision);

/** A decision's message (`reply`) or reason (`block`); `""` for `allow`. */
export const decisionTextOf = (decision: ToolCallDecision<unknown>): string =>
  readers.text(decision);

/** The input an `allow({ input })` gives, boxed; none for any other decision. */
export const decisionInputOf = (
  decision: ToolCallDecision<unknown>,
): { readonly value: unknown } | undefined => readers.input(decision);

/** One tool call as an interceptor sees it: the tool, and its arguments with PII revealed. */
export interface ToolCallContext {
  /** The `@Tool` / `@McpTool` called, by its `name`. */
  readonly tool: ComponentRecord;
  /** The agent whose loop makes the call. */
  readonly agent: ComponentRecord;
  /** The call's id in the agent's loop: the same on a re-run of the call. */
  readonly callId: string;
  /** The arguments the model gave, PII tokens revealed (real values), not validated yet. */
  readonly input: unknown;
}

/** One finished tool call: its arguments and its result, validated against the tool's output. */
export interface ToolCallResultContext extends ToolCallContext {
  /** The tool's result — or the value an inner hook gave. */
  readonly output: unknown;
}

const toolTypes = new WeakMap<object, Class>();

/** Notes the `@Tool` class of a call's context (framework code only). */
export const withToolType = <TContext extends ToolCallContext>(
  context: TContext,
  type: Class,
): TContext => {
  toolTypes.set(context, type);
  return context;
};

/** What a call's context gives about its tool. */
export const ToolCall = {
  /** The `@Tool` / `@McpTool` class a call is for: `ToolCall.typeOf(call) === OrderStatusTool`. */
  typeOf(call: ToolCallContext): Class {
    const type = toolTypes.get(call);
    if (type === undefined) throw new TypeError("ToolCall.typeOf: not a tool call context");
    return type;
  },
} as const;
