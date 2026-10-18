import type { BaseMessage, MessageContent } from "@langchain/core/messages";
import type { JudgeVerdict } from "../components/judge-decorators.js";
import type { NodeValue } from "../flow/runtime/scope.js";
import type { PendingPause } from "../pause/index.js";
import type { RagRetrieval } from "../rag/types.js";

/**
 * The payloads observer hooks receive (`@Workflow({ observers })`). Each event names the node it
 * is about and carries the run's `AppState`.
 */
export interface AppState {
  readonly runId: string;
  readonly threadId?: string;
  /** Name of the current agent, router, tool's agent or action. */
  readonly activeNode?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly history?: readonly unknown[];
}

/** The start of a named step (agent, router, knowledge base, guardrail, policy, action, channel). */
interface StartEvent<I> {
  readonly name: string;
  readonly input: I;
  readonly state: AppState;
}

/** The end of a named step, with what it produced. */
interface EndEvent<U> {
  readonly name: string;
  readonly update: U;
  readonly state: AppState;
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
export interface ToolStartEvent {
  readonly toolName: string;
  readonly agentName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly state: AppState;
}

/** A tool returned: `update` is the text the model sees. */
export interface ToolEndEvent {
  readonly toolName: string;
  readonly agentName: string;
  readonly update: string;
  readonly state: AppState;
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

/** The human's feedback and argument overrides, before and after a PII policy masked them. */
export interface PiiPolicyPayload {
  readonly feedback?: string;
  readonly overrideArgs?: unknown;
}
export type PiiPolicyStartEvent = StartEvent<PiiPolicyPayload>;
export type PiiPolicyEndEvent = EndEvent<PiiPolicyPayload>;

/** An `@Action` starts with its input fields (`Produced` values). */
export type ActionStartEvent = StartEvent<Readonly<Record<string, unknown>>>;
/** An action finished: `update` is what its `execute` returned. */
export type ActionEndEvent = EndEvent<unknown>;

/** An approval request goes out on a channel: `input` is the tool call's arguments. */
export type ChannelStartEvent = StartEvent<unknown>;
/** A channel answered: `update` is the raw decision, before the channel's adapter reads it. */
export type ChannelEndEvent = EndEvent<unknown>;

/** A model is called by an agent (`callerName`) with the conversation so far. */
export interface ModelStartEvent {
  readonly modelName: string;
  readonly callerName: string;
  readonly rawPayload: readonly BaseMessage[];
  readonly state: AppState;
}

/** A model answered: its content, token usage and cost. */
export interface ModelEndEvent {
  readonly model: string;
  readonly callerName: string;
  readonly rawContent: MessageContent;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly calculatedCost?: number;
  readonly state: AppState;
}

/** A judge evaluates an agent's reply (`input`). */
export interface JudgeStartEvent {
  readonly name: string;
  readonly agentName: string;
  readonly input: unknown;
  readonly state: AppState;
}

/** A judge's verdict. */
export interface JudgeEndEvent {
  readonly name: string;
  readonly agentName: string;
  readonly update: JudgeVerdict;
  readonly state: AppState;
}

/** A run paused (`ExecutionStatus.Paused`): `pause` is what it waits for. */
export interface WorkflowPauseEvent {
  readonly pause: PendingPause;
  readonly state: AppState;
}

/** Why a run continues (#265 S30). */
export enum ResumeReason {
  /** `app.resume` answered its pause with a decision. */
  Answered = "answered",
  /**
   * Recovery: its instance died or stopped while the run moved, and this instance continues it
   * from its last checkpoint (taking a decision recorded meanwhile, if any).
   */
  Recovered = "recovered",
}

/**
 * A run continues: `app.resume` picked a paused run up with `decision` (`ResumeReason.Answered`),
 * or recovery continues an interrupted one (`ResumeReason.Recovered`; `decision` only when it
 * takes a recorded one). The run's id is the one it started with.
 */
export interface WorkflowResumeEvent {
  /** Why it continues. */
  readonly reason: ResumeReason;
  /** The decision it continues with (`undefined` for a recovery that takes none). */
  readonly decision: unknown;
  /** Its run id and thread. */
  readonly state: AppState;
}

/** What a caller asked the app for: `app.execute`, `app.resume` or `app.cancel`. */
export type RunOperation = "execute" | "resume" | "cancel";

/**
 * A request the app refused before any run work (`onRunRejected`): a thread of another owner, a
 * resume with nothing paused, an unknown thread, an invalid start input. No run started or was
 * located, so it carries no run id (never another owner's) and never the input values; the error
 * is still thrown to the caller.
 */
export interface RunRejectedEvent {
  /** The app call that was refused. */
  readonly operation: RunOperation;
  /** The thread the request named; absent for an `execute` without one. */
  readonly threadId?: string;
  /** The error's stable code (`run.thread-owner`, `run.not-paused`, `dto.invalid`, …). */
  readonly code: string;
  /** What went wrong, without the input values (`invalid WorkflowStartTextDto at text`). */
  readonly message: string;
  /** The request's thread, as on other events; no `runId`. */
  readonly state: Omit<AppState, "runId">;
}
