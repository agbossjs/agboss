import type { RunnableConfig } from "@langchain/core/runnables";
import { recordReportedCost, type UsageRecord } from "../../finops/usage.js";
import {
  ToolTimeoutError,
  type AnyTool,
  type ToolCallContext,
  type ToolOutput,
} from "../../tools/index.js";
import { argumentsRefusal, closedResult, type ClosedResult } from "./tool-pii.js";
import { toolNamed, type AgentLoopDeps } from "./deps.js";
import type { AgentLoopUpdate, ToolTask } from "./state.js";
import { inToolCallFrame } from "../../flow/context/frame.js";
import {
  extractRunContext,
  throwIfCancelled,
  type NodeRunContext,
} from "../../core/run-context.js";
import { timeoutOn } from "../../infrastructure/clock-timeout.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A tool call's signal and the release of its timer once the call has ended. */
interface CallSignal {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

/**
 * The call's signal (#280 S45): the execution's (cancel included) combined with a timer of the
 * tool's own `timeout` on the application's clock (#262) and the budgets' `exhausted` (#338) —
 * what `executionContext.signal` reads in the call's frame.
 */
function callSignalOf(
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

/** Tool failures are recoverable: whatever went wrong, the model reads it as `Tool error: …`. */
async function runTool(
  tool: AnyTool,
  args: unknown,
  context: ToolCallContext,
): Promise<ToolOutput<unknown>> {
  try {
    return await tool.invoke(args, context);
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "GraphInterrupt") {
      throw error;
    }
    return { kind: "error", message: errorMessage(error) };
  }
}

/** The call in its frame: refused by a block rule in its arguments, or run and its result closed (#120). */
async function guardedCall(
  deps: AgentLoopDeps,
  tool: AnyTool,
  task: ToolTask,
  run: () => Promise<ToolOutput<unknown>>,
): Promise<ClosedResult> {
  const refusal = await argumentsRefusal(deps.pii, task.args);
  if (refusal.content !== undefined)
    return { content: refusal.content, piiTokens: {}, piiMasked: {}, usage: refusal.usage };
  const closed = await closedResult(deps.pii, tool, await run());
  return { ...closed, usage: [...refusal.usage, ...closed.usage] };
}

/**
 * One tool call = one task (`Send`): its result is stored under its call id as soon as it finishes,
 * so a crash later never repeats it. A call running when the process died runs again with the same
 * `callId` — part of its idempotency key (`executionContext.step.idempotencyKey`). The call runs in
 * its own frame; reported costs and the model spend of `ROUTER_FACTORY` routers land in the loop's
 * usage as the tool's.
 */
export function makeToolNode(
  deps: AgentLoopDeps,
): (task: ToolTask, config?: RunnableConfig) => Promise<AgentLoopUpdate> {
  return async (task, config) => {
    const tool = toolNamed(deps.agent, task.tool);
    const runCtx = extractRunContext(config, task.runId);
    if (tool === undefined) return {};
    throwIfCancelled(runCtx.run);
    const usage: UsageRecord[] = [];
    const caller = tool.costCaller ?? `tool:${tool.name}`;
    const call = callSignalOf(tool, config, runCtx, deps.budgets.exhausted);
    // a service's spend counted the moment it is reported (#338), and kept for the loop's usage
    const keep = (record: UsageRecord): void => {
      usage.push(record);
      deps.budgets.tally([record]);
    };
    const context: ToolCallContext = {
      signal: call.signal,
      clock: runCtx.clock,
      reportCost: (usd) => {
        keep(recordReportedCost(tool, usd));
      },
    };
    const reportUsage = (spent: UsageRecord): void => {
      keep({ ...spent, caller });
    };
    const event = { toolName: task.tool, agentName: deps.agent.name };
    await reportNodeEvent((base) =>
      deps.observer?.onToolStart({ ...base, ...event, arguments: task.args }),
    );
    const closed = await inToolCallFrame(
      task.callId,
      { reportUsage },
      () => guardedCall(deps, tool, task, () => runTool(tool, task.args, context)),
      call.signal,
    ).finally(call.release);
    deps.budgets.tally(closed.usage);
    const { content, piiTokens, piiMasked } = closed;
    await reportNodeEvent((base) =>
      deps.observer?.onToolEnd({ ...base, ...event, update: content }),
    );
    const results = { [task.callId]: { callId: task.callId, tool: task.tool, content } };
    return { results, usage: [...usage, ...closed.usage], piiTokens, piiMasked };
  };
}
