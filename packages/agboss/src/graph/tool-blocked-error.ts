import type { UsageRecord } from "../finops/usage.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { StepFailedError, stepCoordinatesOf } from "./errors.js";

/** What a blocked tool call takes (#906): the call, why, and the spend of the step. */
export interface ToolBlockedErrorOptions {
  readonly agent: string;
  readonly tool: string;
  readonly interceptor: string;
  readonly reason: string;
  readonly usage: readonly UsageRecord[];
  /** What blocked it, when it is more than the reason: the reason is the cause by default. */
  readonly cause?: unknown;
}

/**
 * A tool interceptor's `beforeToolCall` returned `ToolCallDecision.block({ reason })` (#384): the
 * tool was not called and the agent's step fails at once — a `StepFailedError`, so
 * `.onError(ToolBlockedError, …)` (or `StepFailedError`) after the agent takes it.
 */
export class ToolBlockedError extends StepFailedError {
  static override readonly code = "step.tool-blocked" as const;
  declare readonly code: typeof ToolBlockedError.code;
  override name = "ToolBlockedError";
  /** The agent whose call was blocked. */
  readonly agent: string;
  /** The tool it called, by `name`. */
  readonly tool: string;
  /** The interceptor that blocked it, by `name`. */
  readonly interceptor: string;
  /** Why: the decision's `reason`. */
  readonly reason: string;

  constructor(options: ToolBlockedErrorOptions) {
    const { agent, tool, interceptor, reason, usage, cause } = options;
    super({
      message: `Agent "${agent}": the call to ${tool} was blocked by ${interceptor}: ${reason}`,
      usage,
      cause: cause ?? reason,
      ...stepCoordinatesOf(agent, ComponentKind.Agent),
      details: { agent, tool, interceptor, reason },
    });
    this.agent = agent;
    this.tool = tool;
    this.interceptor = interceptor;
    this.reason = reason;
  }
}
