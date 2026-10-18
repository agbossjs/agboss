import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import type { JudgeVerdict } from "../components/judge-decorators.js";
import type { CostReport } from "../finops/usage.js";
import type { ExecutionEvent, NodeEvent } from "../flow/observers/execution-event.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import type { NodeValue } from "../flow/runtime/scope.js";
import type { PendingPause } from "../pause/index.js";
import type { RagRetrieval } from "../rag/types.js";

/**
 * The payloads observer hooks receive (`@Application({ observers })`, #261): one event object per
 * hook, plain data. Every execution event carries `executionId`, `parentExecutionId`,
 * `rootExecutionId`, `threadId`, `tenantId` and `workflow` (`ExecutionEvent`); a node event adds
 * the `step` it is about (`NodeEvent`). The full record of an execution is `result.record`.
 */

/** The start of a named part of a step (agent, router, knowledge base, guardrail, policy, action, channel). */
interface StartEvent<I> extends NodeEvent {
  /** What starts: the agent, router or action (`step.component.name`), or the part inside it. */
  readonly name: string;
  readonly input: I;
}

/** The end of a named part of a step, with what it produced. */
interface EndEvent<U> extends NodeEvent {
  readonly name: string;
  readonly update: U;
}

/** An agent starts: `input` is its input message (#270 Q51). */
export type AgentStartEvent = StartEvent<string>;
/** An agent answered: `update` is its value (and its class for a `oneOf`). */
export type AgentEndEvent = EndEvent<NodeValue>;

/** A router starts: `input` is its input message. */
export type RouterStartEvent = StartEvent<string>;

/** What a router decided: the route's node id and why. */
export interface RouterDecided {
  readonly route: string;
  readonly reason: string;
}

/** A router decided. */
export type RouterEndEvent = EndEvent<RouterDecided>;

/** A knowledge base (`@Rag`, context mode) is searched: `input` is the query. */
export type RagStartEvent = StartEvent<string>;
/** A knowledge base answered. */
export type RagEndEvent = EndEvent<RagRetrieval>;

/** A tool is called by an agent, with the model's (validated) arguments. */
export interface ToolStartEvent extends NodeEvent {
  readonly toolName: string;
  readonly agentName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** A tool returned: `update` is the text the model sees. */
export interface ToolEndEvent extends NodeEvent {
  readonly toolName: string;
  readonly agentName: string;
  readonly update: string;
}

/** What a guardrail is shown: the judge point, its context and (on a channel) the decision. */
export interface GuardrailInput {
  readonly point: string;
  readonly ctx: unknown;
  readonly decision?: unknown;
}
export type GuardrailStartEvent = StartEvent<GuardrailInput>;
/** A guardrail ran: `update` is what it returned (a verdict, overrides, or nothing). */
export type GuardrailEndEvent = EndEvent<unknown>;

/** An `@Action` starts with its input fields (`Produced` values). */
export type ActionStartEvent = StartEvent<Readonly<Record<string, unknown>>>;
/** An action finished: `update` is what its `execute` returned. */
export type ActionEndEvent = EndEvent<unknown>;

/** An approval request goes out on a channel: `input` is the tool call's arguments. */
export type ChannelStartEvent = StartEvent<unknown>;
/** A channel answered: `update` is the raw decision, before the channel's adapter reads it. */
export type ChannelEndEvent = EndEvent<unknown>;

/** A model is called by an agent (`callerName`) with the conversation so far. */
export interface ModelStartEvent extends NodeEvent {
  readonly modelName: string;
  readonly callerName: string;
  readonly rawPayload: readonly BaseMessage[];
}

/** The tokens of one model call. */
export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** A model answered: its content, token usage and cost. */
export interface ModelEndEvent extends NodeEvent {
  readonly model: string;
  readonly callerName: string;
  readonly rawContent: MessageContent;
  readonly usage: ModelUsage;
  readonly calculatedCost?: number;
}

/** A judge evaluates an agent's reply (`input`). */
export interface JudgeStartEvent extends NodeEvent {
  readonly name: string;
  readonly agentName: string;
  readonly input: unknown;
}

/** A judge's verdict. */
export interface JudgeEndEvent extends NodeEvent {
  readonly name: string;
  readonly agentName: string;
  readonly update: JudgeVerdict;
}

/** An execution starts (`onExecutionStart`): once, at `app.execute` — a resume does not start it again. */
export type ExecutionStartEvent = ExecutionEvent;

/**
 * An execution ended at a finish (`onExecutionEnd`): once per execution, also when it finishes
 * after a resume — a pause is `onExecutionPause`, a failure `onExecutionError`.
 */
export interface ExecutionEndEvent extends ExecutionEvent {
  /** The workflow finish it reached. */
  readonly finish: ComponentRecord;
  /** What it cost, all its passes together. */
  readonly spend: CostReport;
}

/** An execution paused (`ExecutionStatus.Paused`): `pause` is what it waits for. */
export interface ExecutionPauseEvent extends ExecutionEvent {
  readonly pause: PendingPause;
}

/** Why an execution continues (#265 S30). */
export enum ResumeReason {
  /** `app.resume` answered its pause with a decision. */
  Answered = "answered",
  /**
   * Recovery: its instance died or stopped while the execution moved, and this instance continues
   * it from its last checkpoint (taking a decision recorded meanwhile, if any).
   */
  Recovered = "recovered",
}

/**
 * An execution continues: `app.resume` picked a paused one up with `decision`
 * (`ResumeReason.Answered`), or recovery continues an interrupted one (`ResumeReason.Recovered`;
 * `decision` only when it takes a recorded one). Its id is the one it started with.
 */
export interface ExecutionResumeEvent extends ExecutionEvent {
  /** Why it continues. */
  readonly reason: ResumeReason;
  /** The decision it continues with (`undefined` for a recovery that takes none). */
  readonly decision: unknown;
}

/**
 * An execution failed (`onExecutionError`) — also after a resume, or cancelled while paused
 * (`ExecutionCancelledError`) — or a resume of a paused one was refused as incompatible
 * (`IncompatibleResumeError`; it stays paused).
 */
export interface ExecutionErrorEvent extends ExecutionEvent {
  readonly error: Error;
}

/** What a caller asked the app for (#269): `app.execute`, `app.resume` or `app.cancel`. */
export enum ExecutionOperation {
  Execute = "execute",
  Resume = "resume",
  Cancel = "cancel",
}

/**
 * A request the app refused before any execution work (`onExecutionRejected`): a thread of another
 * owner, a resume with nothing paused, an unknown thread, invalid start input or context values, an
 * exhausted budget, a stopping app. No execution started or was located, so it carries no
 * `executionId` (never another owner's) and never the input values; the error is still thrown.
 */
export interface ExecutionRejectedEvent {
  /** The app call that was refused. */
  readonly operation: ExecutionOperation;
  /** The thread the request named; absent for an `execute` without one. */
  readonly threadId?: string;
  /** The tenant the request named (`"default"` when it named none, or its values were invalid). */
  readonly tenantId: string;
  /** The error's stable code (`run.thread-owner`, `run.not-paused`, `dto.invalid`, …). */
  readonly code: string;
  /** What went wrong, without the input values (`invalid WorkflowStartTextDto at text`). */
  readonly message: string;
}
