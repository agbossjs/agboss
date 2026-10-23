import { errorRecordOf } from "../../core/error-record.js";
import type { StepRecord } from "../../flow/context/execution-context.js";
import { currentFrame, toolCallFrameOf, type LoopProgress } from "../../flow/context/frame.js";
import { stepRecordOf } from "../../flow/observers/execution-event.js";
import { bareRecordOf, ComponentKind, type ComponentRecord } from "../../flow/runtime/records.js";
import { ToolCallStatus, type ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import { toolRecordOf } from "../../flow/runtime/tool-keys.js";
import { ToolTimeoutError, type AnyTool, type ToolOutput } from "../../tools/index.js";
import type { InvalidToolCallRequest } from "./deps.js";
import { ToolCallStopKind, type ToolCallStop } from "./tool-stops.js";
import { ToolBlockedError } from "../tool-blocked-error.js";

/**
 * The records of an agent's tool calls (#395): each call's step — the agent's visit with the call's
 * id, its tool as the component — what it was called with and how it ended. Made where the call
 * ends: its task, its declined approval, the move boundary for an unparsable one.
 */

/** When a call started and ended (the application's `Clock`). */
export interface CallTimes {
  readonly startedAt: Date;
  readonly endedAt: Date;
}

/**
 * The call's step: the current step's (the agent's visit) with the call's id and key, the loop's
 * progress and the tool as its component; an agent loop run on its own has no step — a bare one.
 */
export function callStepOf(
  component: ComponentRecord,
  callId: string,
  progress: LoopProgress,
  agent: string,
): StepRecord {
  const frame = currentFrame();
  if (frame === undefined)
    return {
      component,
      nodeId: agent,
      visitNumber: 1,
      copyNumber: 1,
      itemIndex: undefined,
      idempotencyKey: callId,
      callId,
      ...progress,
    };
  const step = frame.step.callId === callId ? frame.step : toolCallFrameOf(frame, callId).step;
  return { ...stepRecordOf(step), ...progress, component };
}

const timesOf = (times: CallTimes): Pick<ToolCallRecord, "startedAt" | "endedAt"> => ({
  startedAt: times.startedAt.toISOString(),
  endedAt: times.endedAt.toISOString(),
});

/** How a call that ran (or was refused) ended. */
export interface EndedCall {
  readonly tool: AnyTool;
  readonly step: StepRecord;
  readonly args: unknown;
  /** The tool's output; `undefined` when a PII rule refused the call before it ran. */
  readonly output?: ToolOutput<unknown>;
  /** The PII refusal of its arguments or its result (#120). */
  readonly refusal?: Error;
  /** An interceptor's `replyToModel` message (#384): the tool never ran. */
  readonly replied?: string;
  /** How an interceptor stopped it (#384): the tool never ran. */
  readonly stop?: ToolCallStop;
  readonly isResultTruncated: boolean;
}

/** A call its interceptors ended before the tool ran (#384); `undefined` when they did not. */
function interceptedOf(
  call: EndedCall,
): Pick<ToolCallRecord, "status" | "output" | "error"> | undefined {
  if (call.replied !== undefined) return { status: ToolCallStatus.Replied, output: call.replied };
  const { stop } = call;
  if (stop === undefined) return undefined;
  if (stop.kind === ToolCallStopKind.Failed)
    return { status: ToolCallStatus.Failed, output: undefined, error: errorRecordOf(stop.reason) };
  const blocked = { agent: call.step.nodeId, tool: call.tool.name, ...stop };
  const error = errorRecordOf(new ToolBlockedError(blocked, []));
  return { status: ToolCallStatus.Blocked, output: undefined, error };
}

/** The status, output and error of a call whose arguments passed the tool's input check. */
function outcomeOf(call: EndedCall): Pick<ToolCallRecord, "status" | "output" | "error"> {
  if (call.refusal !== undefined)
    return { status: ToolCallStatus.Failed, output: undefined, error: errorRecordOf(call.refusal) };
  const { output } = call;
  if (output?.kind === "ok") return { status: ToolCallStatus.Succeeded, output: output.value };
  const cause = output?.cause;
  const status =
    cause instanceof ToolTimeoutError ? ToolCallStatus.TimedOut : ToolCallStatus.Failed;
  return { status, output: undefined, error: errorRecordOf(cause ?? output?.message ?? "") };
}

/** The record of a call that reached its task. */
export function endedCallRecordOf(call: EndedCall, times: CallTimes): ToolCallRecord {
  const base = { step: call.step, isResultTruncated: call.isResultTruncated, ...timesOf(times) };
  const intercepted = interceptedOf(call);
  if (intercepted !== undefined) return { ...base, input: call.args, ...intercepted };
  const input = call.tool.input.safeParse(call.args);
  if (!input.success)
    return {
      ...base,
      input: call.args,
      output: undefined,
      status: ToolCallStatus.InvalidArguments,
      error: errorRecordOf(call.output?.kind === "error" ? call.output.message : ""),
    };
  return { ...base, input: input.data, ...outcomeOf(call) };
}

/** The record of a call its approval declined: it never ran. */
export function declinedCallRecordOf(step: StepRecord, args: unknown, at: Date): ToolCallRecord {
  const times = { startedAt: at, endedAt: at };
  return {
    step,
    input: args,
    output: undefined,
    status: ToolCallStatus.Declined,
    isResultTruncated: false,
    ...timesOf(times),
  };
}

/** The record of a call whose arguments were no JSON: it never ran. */
export function unreadCallRecordOf(
  call: InvalidToolCallRequest,
  tool: AnyTool | undefined,
  progress: LoopProgress,
  site: { readonly agent: string; readonly at: Date },
): ToolCallRecord {
  const component =
    tool === undefined ? bareRecordOf(call.tool, ComponentKind.Tool) : toolRecordOf(tool);
  return {
    step: callStepOf(component, call.callId, progress, site.agent),
    input: call.args,
    output: undefined,
    status: ToolCallStatus.InvalidArguments,
    error: errorRecordOf(call.problem),
    isResultTruncated: false,
    ...timesOf({ startedAt: site.at, endedAt: site.at }),
  };
}
