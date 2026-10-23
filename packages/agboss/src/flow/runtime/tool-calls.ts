import type { ErrorRecord } from "../../core/error-record.js";
import type { ToolHandler } from "../../components/decorators.js";
import type { Class } from "../../components/injection.js";
import { nameOf } from "../../components/name-of.js";
import type { StepRecord } from "../context/execution-context.js";
import { ComponentKind } from "./records.js";
import type { ToolCallRemote } from "../../mesh/mesh-call.js";

/**
 * The tool-call trajectory of an execution (#395): one record per call an agent's model asked for,
 * in call order — what it was called with, how it ended and what it gave. `result.toolCalls`,
 * `result.record.toolCalls`, each child's `toolCalls` and a judge's `input.toolCalls` (the calls of
 * the visit it judges) hold them; the records of `result.record` are masked like the rest of it.
 */

/** How one tool call ended. */
export enum ToolCallStatus {
  /** The tool ran and its output passed its output check. */
  Succeeded = "succeeded",
  /** The tool threw or its output failed its check; a PII refusal too (`error.code` `pii.refused`). */
  Failed = "failed",
  /**
   * The arguments failed the tool's input check, or were no JSON at all (a truncated call — the
   * model's `invalid_tool_calls`): the tool never ran; counted in `step.validationAttempts`.
   */
  InvalidArguments = "invalid-arguments",
  /** Its approval answered `approved: false`: the tool never ran. */
  Declined = "declined",
  /** The tool ran past its `timeout`. */
  TimedOut = "timed-out",
  /**
   * A tool interceptor answered the model instead (#384: `ToolCallDecision.replyToModel`): the tool
   * never ran; `output` is the message the model read.
   */
  Replied = "replied",
  /**
   * A tool interceptor stopped the call (#384: `ToolCallDecision.block`): the tool never ran and the
   * step fails with `ToolBlockedError` (its record in `error`).
   */
  Blocked = "blocked",
  /**
   * The model called a tool its agent does not have (#395 S6): nothing ran, the model read that
   * there is no such tool; `step.component` names what it called.
   */
  UnknownTool = "unknown-tool",
}

/** One tool call of an agent's visit, as plain data. */
export interface ToolCallRecord {
  /**
   * The call's step: `component` is the tool (with its join keys), `nodeId` and `visitNumber` the
   * agent's visit, `callId`, `toolLoopIteration` (the model call that asked for it) and
   * `validationAttempts` (the visit's failed validations before it).
   */
  readonly step: StepRecord;
  /** The arguments: as the tool's input check gave them, or as the model gave them when invalid. */
  readonly input: unknown;
  /** The tool's output (an interceptor's message when `Replied`); `undefined` otherwise. */
  readonly output: unknown;
  readonly status: ToolCallStatus;
  /** Why it failed or timed out; `undefined` otherwise. */
  readonly error?: ErrorRecord;
  /** Whether the model read its result cut to `maxResultSize` (#336). */
  readonly isResultTruncated: boolean;
  /** When it started and ended (ISO 8601, the application's `Clock`). */
  readonly startedAt: string;
  readonly endedAt: string;
  /**
   * The remote execution the call ran (#398 PR 2, C8): an AGBoss peer's application and execution
   * id, from the run report it signed; `undefined` for any other call.
   */
  readonly remote?: ToolCallRemote;
}

/** A succeeded call of one tool: its input and output typed by the tool. */
export interface SucceededToolCall<TInput, TOutput> extends ToolCallRecord {
  readonly status: ToolCallStatus.Succeeded;
  readonly input: TInput;
  readonly output: TOutput;
}

/** A call of one tool that ran (or was refused) on valid arguments and gave no output. */
export interface FailedToolCall<TInput> extends ToolCallRecord {
  readonly status: ToolCallStatus.Failed | ToolCallStatus.TimedOut;
  readonly input: TInput;
  readonly output: undefined;
}

/** A call of one tool that never ran: its arguments are the model's, unchecked. */
export interface UncheckedToolCall extends ToolCallRecord {
  readonly status:
    | ToolCallStatus.InvalidArguments
    | ToolCallStatus.Declined
    | ToolCallStatus.Replied
    | ToolCallStatus.Blocked
    | ToolCallStatus.UnknownTool;
  /** An interceptor's message to the model (`Replied`); `undefined` otherwise. */
  readonly output: string | undefined;
}

/** One call of a tool, typed by the tool's input and output — discriminated by `status`. */
export type TypedToolCall<TInput, TOutput> =
  SucceededToolCall<TInput, TOutput> | FailedToolCall<TInput> | UncheckedToolCall;

/**
 * The calls of one tool in a trajectory, in call order, typed by the tool:
 * `toolCallsOf(GetOrderTool, input.toolCalls).filter((call) => call.status === ToolCallStatus.Succeeded)`.
 */
export function toolCallsOf<TInput, TOutput>(
  tool: Class<ToolHandler<TInput, TOutput>>,
  toolCalls: readonly ToolCallRecord[],
): readonly TypedToolCall<TInput, TOutput>[] {
  const name = nameOf(tool);
  return toolCalls.filter(
    (call): call is TypedToolCall<TInput, TOutput> =>
      call.step.component.kind === ComponentKind.Tool && call.step.component.name === name,
  );
}
