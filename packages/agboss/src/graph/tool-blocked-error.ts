import type { UsageRecord } from "../finops/usage.js";
import { ComponentKind } from "../flow/runtime/records.js";
import { StepFailedError, stepCoordinatesOf } from "./errors.js";

/**
 * A tool interceptor's `beforeToolCall` returned `ToolCallDecision.block({ reason })` (#384): the
 * tool was not called and the agent's step fails at once — a `StepFailedError`, so
 * `.onError(ToolBlockedError, …)` (or `StepFailedError`) after the agent takes it.
 */
export class ToolBlockedError extends StepFailedError {
  static override readonly code: string = "step.tool-blocked";
  override name = "ToolBlockedError";
  /** The agent whose call was blocked. */
  readonly agent: string;
  /** The tool it called, by `name`. */
  readonly tool: string;
  /** The interceptor that blocked it, by `name`. */
  readonly interceptor: string;
  /** Why: the decision's `reason`. */
  readonly reason: string;

  constructor(
    call: {
      readonly agent: string;
      readonly tool: string;
      readonly interceptor: string;
      readonly reason: string;
    },
    usage: readonly UsageRecord[],
  ) {
    const { agent, tool, interceptor, reason } = call;
    super(
      `Agent "${agent}": the call to ${tool} was blocked by ${interceptor}: ${reason}`,
      usage,
      reason,
      stepCoordinatesOf(agent, ComponentKind.Agent),
      { agent, tool, interceptor, reason },
    );
    this.agent = agent;
    this.tool = tool;
    this.interceptor = interceptor;
    this.reason = reason;
  }
}
