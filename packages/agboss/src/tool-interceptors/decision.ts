import type { ComponentRecord } from "../flow/runtime/records.js";

/**
 * A tool interceptor's contract (#384): `@ToolInterceptor` classes implement `BeforeToolCall`,
 * `AfterToolCall` or both — two one-method interfaces, so a class never writes an empty second
 * method. `beforeToolCall` decides with `ToolCallDecision.allow()` / `.replyToModel({ message })` /
 * `.block({ reason })`; `afterToolCall` gives the result the model reads instead of the tool's.
 * Small and import-light: part of the root entry.
 */

/** What a decision does with a call (internal: a project reads a decision through `toEqual`). */
export enum ToolCallOutcome {
  Allow = "allow",
  ReplyToModel = "reply-to-model",
  Block = "block",
}

/** Reads a decision's outcome inside the framework; set by the class's static block. */
let outcomeReader: (decision: ToolCallDecision) => ToolCallOutcome;
/** Reads a decision's text — the message to the model, or the reason it blocks. */
let textReader: (decision: ToolCallDecision) => string;

/** What `beforeToolCall` decided on one call: built only with `allow()`, `replyToModel()`, `block()`. */
export class ToolCallDecision {
  /** Nominal: a plain object is not a decision. */
  declare private readonly built: true;

  private constructor(
    private readonly outcome: ToolCallOutcome,
    private readonly text: string,
  ) {
    Object.freeze(this);
  }

  static {
    outcomeReader = (decision) => decision.outcome;
    textReader = (decision) => decision.text;
  }

  /** The call goes on: the next interceptor decides, then the tool runs. */
  static allow(): ToolCallDecision {
    return new ToolCallDecision(ToolCallOutcome.Allow, "");
  }

  /**
   * The tool is not called and the step goes on: the model reads `message` as the call's text
   * result in its loop (bounded by `maxResultSize`, masked by the PII policies) and may try again.
   */
  static replyToModel(options: { readonly message: string }): ToolCallDecision {
    return new ToolCallDecision(ToolCallOutcome.ReplyToModel, options.message);
  }

  /** The tool is not called and the agent's step fails at once with `ToolBlockedError`. */
  static block(options: { readonly reason: string }): ToolCallDecision {
    return new ToolCallDecision(ToolCallOutcome.Block, options.reason);
  }
}

/** Whether a value is a decision built by `ToolCallDecision`'s factories. */
export const isToolCallDecision = (value: unknown): value is ToolCallDecision =>
  value instanceof ToolCallDecision;

/** A decision's outcome (framework code only). */
export const outcomeOf = (decision: ToolCallDecision): ToolCallOutcome => outcomeReader(decision);

/** A decision's message (`replyToModel`) or reason (`block`); `""` for `allow`. */
export const decisionTextOf = (decision: ToolCallDecision): string => textReader(decision);

/** One tool call as an interceptor sees it: the tool, and its arguments with PII revealed. */
export interface ToolCallContext {
  /** The `@Tool` / `@McpTool` called, by its `name`. */
  readonly tool: ComponentRecord;
  /** The arguments the model gave, PII tokens revealed (real values), not validated yet. */
  readonly input: unknown;
}

/** One finished tool call: its arguments and its result, validated against the tool's output. */
export interface ToolCallResultContext extends ToolCallContext {
  /** The tool's result — or the value an inner interceptor's `afterToolCall` gave. */
  readonly output: unknown;
}

/** An interceptor that decides before the tool runs. */
export interface BeforeToolCall {
  beforeToolCall(call: ToolCallContext): Promise<ToolCallDecision> | ToolCallDecision;
}

/** An interceptor that reads, or replaces, the tool's result before the model reads it. */
export interface AfterToolCall {
  /** The output the model reads instead (a promise of it, too), validated against the tool's output. */
  afterToolCall(call: ToolCallResultContext): unknown;
}
