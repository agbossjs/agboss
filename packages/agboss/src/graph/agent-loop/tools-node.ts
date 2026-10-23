import type { RunnableConfig } from "@langchain/core/runnables";
import { recordReportedCost, type UsageRecord } from "../../finops/usage.js";
import {
  ToolTimeoutError,
  type AnyTool,
  type ToolInvocationContext,
  type ToolOutput,
} from "../../tools/index.js";
import { argumentsRefusal, closedResult, type ClosedResult } from "./tool-pii.js";
import { toolNamed, type AgentLoopDeps } from "./deps.js";
import { callStepOf, endedCallRecordOf, type CallTimes } from "./call-records.js";
import { toolRecordOf } from "../../flow/runtime/tool-keys.js";
import type { StepRecord } from "../../flow/context/execution-context.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import { interceptedCall } from "./tool-interception.js";
import { keepStopCause, type ToolCallStop } from "./tool-stops.js";
import { storedCallOf } from "./stored-call.js";
import type { AgentLoopUpdate, ToolTask } from "./state.js";
import { inLoopFrame, inToolCallFrame } from "../../flow/context/frame.js";
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

/**
 * A guarded call: its result for the model, how its interceptors ended it (#384) and what the tool
 * gave — none when it was refused, answered by an interceptor or stopped — and its step (#395).
 */
interface GuardedCall {
  readonly closed: ClosedResult;
  readonly step: StepRecord;
  readonly output?: ToolOutput<unknown>;
  /** An interceptor's `replyToModel` message: the tool never ran. */
  readonly replied?: string;
  readonly stop?: ToolCallStop;
}

/** Tool failures are recoverable: whatever went wrong, the model reads it as `Tool error: …`. */
async function runTool(
  tool: AnyTool,
  args: unknown,
  context: ToolInvocationContext,
): Promise<ToolOutput<unknown>> {
  try {
    return await tool.invoke(args, context);
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "GraphInterrupt") {
      throw error;
    }
    return { kind: "error", message: errorMessage(error), cause: error };
  }
}

/** What the model would read of a stopped call: the loop fails the step before it reads it. */
const stoppedContent = (stop: ToolCallStop): string =>
  `Tool error: the call was stopped by ${stop.interceptor}: ${stop.reason}`;

/**
 * The call in its frame: refused by a block rule in its arguments, else through its tool
 * interceptors (#384) — run, answered by an interceptor or stopped — and its result closed (#120).
 */
async function guardedCall(
  deps: AgentLoopDeps,
  tool: AnyTool,
  task: ToolTask,
  run: () => Promise<ToolOutput<unknown>>,
): Promise<GuardedCall> {
  const progress = task.progress ?? { toolLoopIteration: 0, validationAttempts: 0 };
  const step = callStepOf(toolRecordOf(tool), task.callId, progress, deps.agent.name);
  const set = deps.pii?.withFieldKey(task.piiKey);
  const refusal = await argumentsRefusal(set, task.args);
  if (refusal.content !== undefined) {
    const closed = { content: refusal.content, piiTokens: {}, piiMasked: {} };
    const refused = refusal.refusal === undefined ? {} : { refusal: refusal.refusal };
    return { closed: { ...closed, usage: refusal.usage, isTruncated: false, ...refused }, step };
  }
  // the tool's own bound, else its workflow's `defaults.tools` (#336)
  const maxResultSize = tool.maxResultSize ?? deps.agent.maxResultSize;
  const chain = deps.interceptors?.(tool.name) ?? [];
  const keep = (error: unknown): void => {
    keepStopCause(task.runId, task.callId, error);
  };
  const call = await interceptedCall(chain, tool, task.args, run, keep);
  if (call.kind === "stopped") {
    const content = stoppedContent(call.stop);
    const none = { piiTokens: {}, piiMasked: {}, isTruncated: false };
    return { closed: { content, ...none, usage: refusal.usage }, step, stop: call.stop };
  }
  if (call.kind === "replied") {
    const reply = { kind: "ok", value: call.message } as const;
    const closed = await closedResult(set, undefined, reply, maxResultSize);
    const usage = [...refusal.usage, ...closed.usage];
    return { closed: { ...closed, usage }, step, replied: call.message };
  }
  const closed = await closedResult(set, tool, call.output, maxResultSize);
  const usage = [...refusal.usage, ...closed.usage];
  return { closed: { ...closed, usage }, step, output: call.output };
}

/** The record of a guarded call (#395). */
function recordOf(
  tool: AnyTool,
  task: ToolTask,
  guarded: GuardedCall,
  times: CallTimes,
): ToolCallRecord {
  const { closed, output, step, replied, stop } = guarded;
  const call = {
    tool,
    step,
    args: task.args,
    isResultTruncated: closed.isTruncated,
    ...(closed.refusal === undefined ? {} : { refusal: closed.refusal }),
    ...(output === undefined ? {} : { output }),
    ...(replied === undefined ? {} : { replied }),
    ...(stop === undefined ? {} : { stop }),
  };
  return endedCallRecordOf(call, times);
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
  const run = runTask(deps);
  return (task, config) =>
    task.progress === undefined
      ? run(task, config)
      : inLoopFrame(task.progress, () => run(task, config));
}

/** One tool call's task, in the frame it is given. */
function runTask(
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
    const context: ToolInvocationContext = {
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
    const startedAt = runCtx.clock.now();
    const guarded = await inToolCallFrame(
      task.callId,
      { reportUsage },
      () => guardedCall(deps, tool, task, () => runTool(tool, task.args, context)),
      call.signal,
    ).finally(call.release);
    const { closed } = guarded;
    const record = recordOf(tool, task, guarded, { startedAt, endedAt: runCtx.clock.now() });
    deps.budgets.tally(closed.usage);
    await reportNodeEvent((base) =>
      deps.observer?.onToolEnd({
        ...base,
        ...event,
        update: closed.content,
        isResultTruncated: closed.isTruncated,
      }),
    );
    return endedTaskOf(tool, task, guarded, { record, usage });
  };
}

/** What an ended task stores: its result and record by call id, its spend, PII and validation. */
function endedTaskOf(
  tool: AnyTool,
  task: ToolTask,
  guarded: GuardedCall,
  ended: { readonly record: ToolCallRecord; readonly usage: readonly UsageRecord[] },
): AgentLoopUpdate {
  const { closed } = guarded;
  const { content, piiTokens, piiMasked } = closed;
  const results = { [task.callId]: storedCallOf(task, content, guarded) };
  // arguments its tool's input check refused: one more validation attempt of the step (#268 S93)
  const invalidArguments = tool.input.safeParse(task.args).success ? 0 : 1;
  const callRecords = { [task.callId]: ended.record };
  const usage = [...ended.usage, ...closed.usage];
  return { results, callRecords, usage, piiTokens, piiMasked, invalidArguments };
}
