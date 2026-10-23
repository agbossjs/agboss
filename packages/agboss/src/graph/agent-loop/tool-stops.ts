import type { UsageRecord } from "../../finops/usage.js";
import { AgentFailedError, type StepFailedError } from "../errors.js";
import { ToolBlockedError } from "../tool-blocked-error.js";

/**
 * A tool call a tool interceptor stopped (#384): `block({ reason })`, or an interceptor that threw
 * (or gave what it may not). The tool task stores the stop with the call's result — plain data, so a
 * restart replays it — and the collect node, which has the loop's spend, fails the step with it:
 * `ToolBlockedError`, or `AgentFailedError` whose `cause` is the interceptor's own error (kept in
 * this process until the collect node takes it; after a restart, an `Error` with its message).
 */

/** How an interceptor stopped a call. */
export enum ToolCallStopKind {
  /** `ToolCallDecision.block({ reason })`. */
  Blocked = "blocked",
  /** The interceptor threw, or returned no decision / an output its tool does not give. */
  Failed = "failed",
}

/** A stopped call as the loop stores it. */
export interface ToolCallStop {
  readonly kind: ToolCallStopKind;
  readonly interceptor: string;
  /** The block's reason, or the failure's message. */
  readonly reason: string;
}

/** At most this many causes wait for their collect node (a cancelled loop never takes its own). */
const MAX_KEPT_CAUSES = 1000;

const causes = new Map<string, unknown>();

const keyOf = (runId: string, callId: string): string => `${runId}:${callId}`;

/** Keeps an interceptor's error for the collect node of the same pass. */
export function keepStopCause(runId: string, callId: string, error: unknown): void {
  causes.set(keyOf(runId, callId), error);
  if (causes.size <= MAX_KEPT_CAUSES) return;
  const [oldest] = causes.keys();
  if (oldest !== undefined) causes.delete(oldest);
}

/** Takes the error kept for a call, if this process kept one. */
function takeStopCause(runId: string, callId: string): unknown {
  const key = keyOf(runId, callId);
  const cause = causes.get(key);
  causes.delete(key);
  return cause;
}

/** What the stopped call was: its agent, tool, call id and run. */
export interface StoppedCall {
  readonly agent: string;
  readonly tool: string;
  readonly callId: string;
  readonly runId: string;
}

/** The step's failure for a stopped call, with the loop's spend so far. */
export function stopErrorOf(
  call: StoppedCall,
  stop: ToolCallStop,
  usage: readonly UsageRecord[],
): StepFailedError {
  const kept = takeStopCause(call.runId, call.callId);
  if (stop.kind === ToolCallStopKind.Blocked)
    return new ToolBlockedError(
      { agent: call.agent, tool: call.tool, interceptor: stop.interceptor, reason: stop.reason },
      usage,
    );
  const cause = kept ?? new Error(stop.reason);
  return new AgentFailedError(call.agent, usage, cause, {
    tool: call.tool,
    interceptor: stop.interceptor,
  });
}
