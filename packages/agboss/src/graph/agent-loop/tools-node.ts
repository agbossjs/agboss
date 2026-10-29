import { handedOverOf } from "../../app/handed-over.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { recordReportedCost, type UsageRecord } from "../../finops/usage.js";
import type { AnyTool, ToolInvocationContext, ToolOutput } from "../../tools/index.js";
import { argumentsRefusal, closedResult, type ClosedResult } from "./tool-pii.js";
import { toolNamed, type AgentLoopDeps } from "./deps.js";
import { callStepOf, endedCallRecordOf, type CallTimes } from "./call-records.js";
import { toolRecordOf } from "../../flow/runtime/tool-keys.js";
import type { StepRecord } from "../../flow/context/execution-context.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import { interceptedCall } from "./tool-interception.js";
import { keepStopCause, type ToolCallStop } from "./tool-stops.js";
import { storedCallOf } from "./stored-call.js";
import { toolMeshCallOf, type ToolMeshCall } from "./mesh-call.js";
import type { AgentLoopUpdate, ToolTask } from "./state.js";
import { inLoopFrame, inToolCallFrame } from "../../flow/context/frame.js";
import { extractRunContext, throwIfCancelled } from "../../core/run-context.js";
import { callSignalOf } from "./call-signal.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
    // a hand-over (#471: a fenced write too) ends the loop before onToolEnd and the tally
    const handedOver = handedOverOf(error, context.signal);
    if (handedOver !== undefined) throw handedOver;
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
  mesh: ToolMeshCall,
): ToolCallRecord {
  const { closed, output, step, replied, stop } = guarded;
  const remote = mesh.remote();
  const call = {
    tool,
    step,
    args: task.args,
    isResultTruncated: closed.isTruncated,
    ...(closed.refusal === undefined ? {} : { refusal: closed.refusal }),
    ...(output === undefined ? {} : { output }),
    ...(replied === undefined ? {} : { replied }),
    ...(stop === undefined ? {} : { stop }),
    ...(remote === undefined ? {} : { remote }),
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
    const mesh = toolMeshCallOf(tool, deps.budgets, startedAt); // its remote calls' (#398)
    const guarded = await inToolCallFrame(
      task.callId,
      { reportUsage, meshCall: mesh.services },
      () => guardedCall(deps, tool, task, () => runTool(tool, task.args, context)),
      call.signal,
    ).finally(call.release);
    const { closed } = guarded;
    const record = recordOf(tool, task, guarded, { startedAt, endedAt: runCtx.clock.now() }, mesh);
    deps.budgets.tally(closed.usage);
    await reportToolEnd(deps, event, closed);
    return endedTaskOf(tool, task, guarded, { record, usage });
  };
}

/** `onToolEnd` of a call that ended: what the model reads of it. */
const reportToolEnd = (
  deps: AgentLoopDeps,
  event: { readonly toolName: string; readonly agentName: string },
  closed: ClosedResult,
): Promise<void> =>
  reportNodeEvent((base) =>
    deps.observer?.onToolEnd({
      ...base,
      ...event,
      update: closed.content,
      isResultTruncated: closed.isTruncated,
    }),
  );

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
