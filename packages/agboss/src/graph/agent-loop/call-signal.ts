import type { RunnableConfig } from "@langchain/core/runnables";
import type { NodeRunContext } from "../../core/run-context.js";
import { timeoutOn } from "../../infrastructure/clock-timeout.js";
import { ToolTimeoutError, type AnyTool } from "../../tools/index.js";

/** A tool call's signal and the release of its timer once the call has ended. */
export interface CallSignal {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

/**
 * The call's signal (#280 S45): the execution's (cancel included) combined with a timer of the
 * tool's own `timeout` on the application's clock (#262) and the budgets' `exhausted` (#338) —
 * what `executionContext.signal` reads in the call's frame.
 */
export function callSignalOf(
  tool: AnyTool,
  config: RunnableConfig | undefined,
  { run, clock }: NodeRunContext,
  exhausted: AbortSignal,
): CallSignal {
  const timeout = timeoutOn(clock, tool.timeout, () => new ToolTimeoutError(tool.timeout));
  // an exhausted budget (#338) stops the call too: a sibling branch crossed it
  const signals = [run.signal, timeout.signal, exhausted];
  const signal = AbortSignal.any(
    config?.signal === undefined ? signals : [...signals, config.signal],
  );
  return { signal, release: timeout.release };
}
