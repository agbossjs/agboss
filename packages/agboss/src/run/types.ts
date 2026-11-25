import type { CompensationEntry } from "../flow/compensation.js";
import type { ToolCallRecord } from "../flow/runtime/tool-calls.js";
import type { ExecutionStepRecord } from "../flow/runtime/step-records.js";
import type { LaunchRecord } from "../flow/runtime/launch/records.js";
import type { EndedChildRecord, HandledErrorRecord } from "../flow/runtime/child-records.js";
import type { ExecutionStatus } from "../app/types.js";
import type { ErrorRecord } from "../core/error-record.js";
import type { ApplicationBudgets } from "../budgets/execution-budgets.js";
import type { CostReport } from "../finops/usage.js";
import type { OutdatedValueRecord, ScopeRecords } from "../flow/runtime/records.js";
import type { GraphDeps } from "../graph/deps.js";
import type { Compacted } from "./compaction.js";
import type { WaitingPause } from "../pause/index.js";
import type { TurnRecords } from "../turns/index.js";
import type { ExecutionTracing } from "../tracing/index.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import type { ModelProviderType } from "../models/model-provider.decorator.js";
import type { Class } from "../components/injection.js";
import type { AssembledReplyInterpreter } from "../channels/discovery.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { ExecutionOrigin } from "../mesh/mesh-envelope.js";

/** Graph dependencies plus the application's budgets and the Turn store. */
export interface AgentExecutionDeps<TName extends string> extends GraphDeps<TName> {
  /**
   * The application's budgets and their ledger (#261): every execution is checked and counted
   * against them; absent = a workflow run without an application (no budgets).
   */
  readonly budgets?: ApplicationBudgets | undefined;
  readonly turns: TurnRecords;
  /** The application's log: what reports a failed `onStream` listener (#1008); none for a workflow on its own. */
  readonly log?: FrameworkLog | undefined;
  /** Optional tracing (e.g. local Langfuse); runs are identical without it. */
  readonly tracing?: ExecutionTracing | undefined;
  /** Its application's model providers: a transport one (#385) is part of its `configHash`. */
  readonly modelProviders?: readonly ModelProviderType[] | undefined;
  /** Its application's own `FileRedactor` (#899): part of its `configHash` (#1269). */
  readonly ownFileRedactor?: Class | undefined;
  /** Its application's own `FileTranscriber` (#899): part of its `configHash` (#1269). */
  readonly ownFileTranscriber?: Class | undefined;
  /** Its reply interpreters (#267): a model one's rendered instructions are part of its prompt version (#1347c). */
  readonly replyInterpreters?: readonly AssembledReplyInterpreter[] | undefined;
  /** Its model rerankers' prompts, as assembly read them: part of its prompt version (#1347). */
  readonly rerankers?: readonly { readonly name: string; readonly prompt?: string }[] | undefined;
}

/**
 * Which attempt of which step a streamed text belongs to (#1006): parallel branches, child
 * executions and agent chains never share a key, and a retry or the turn after a tool call is the
 * next `attempt` of the same agent and visit.
 */
export interface StreamStep {
  /** The visit's node id as the run knows it (a launch copy: `critic-agent#2`). */
  readonly agent: string;
  /** The visit of that node, from 1 — what `maxVisits` counts. */
  readonly visit: number;
  /**
   * The execution that makes the visit — a child workflow has its own id; a child launched per
   * item adds `:<itemIndex>`.
   */
  readonly branch: string;
  /** The agent's model call in the visit, from 1. */
  readonly attempt: number;
}

/** What an `onStream` event tells (#1311): its `kind`. */
export enum StreamEventKind {
  /** A chunk of an agent's answering text for `step`. */
  TextDelta = "text-delta",
  /** The text streamed for `step` is retracted (#1006): show it no more. */
  Discarded = "discarded",
  /** An agent's tool call as it starts (#848): the tool's name only — never its arguments. */
  ToolCall = "tool-call",
}

/** Why the text streamed for a step is retracted (#1006, #1311). */
export enum StreamDiscardReason {
  /** A judge failed the reply: a retry follows, or the agent fails with `StepError.QualityGate`. */
  JudgeRejected = "judge-rejected",
  /** The turn ended with tool calls: its text is not the reply. */
  ToolTurn = "tool-turn",
  /** The move was refused — a PII token nobody gave, a malformed answer — and the model tries again. */
  InvalidAnswer = "invalid-answer",
  /** The model call failed after partial chunks. */
  StreamBroken = "stream-broken",
  /** The visit failed otherwise: a budget, a cancel, a refusal, a guardrail. */
  Failed = "failed",
}

/**
 * A stream event for real-time UI/CLI updates. The text of a step is provisional until the run ends:
 * a `StreamEventKind.Discarded` event retracts everything streamed for its `step`; the deltas of the
 * steps that were not discarded, joined, are the agent's reply. Every event carries its `step`, so
 * parallel branches never mix (#1311).
 */
export type ExecutionStreamEvent =
  | {
      readonly kind: StreamEventKind.TextDelta;
      readonly delta: string;
      readonly step: StreamStep;
    }
  /** The text streamed for `step` is retracted (#1006): show it no more. */
  | {
      readonly kind: StreamEventKind.Discarded;
      readonly step: StreamStep;
      readonly reason: StreamDiscardReason;
    }
  /**
   * An agent's tool call as it starts (#848): the tool's name only — never its arguments; `step`
   * is the model call of the visit that asked for it (#1311).
   */
  | { readonly kind: StreamEventKind.ToolCall; readonly tool: string; readonly step: StreamStep };

export interface AgentExecutionOptions {
  /** The execution's id, made once by the app (its observer events use it too); default: a new one. */
  readonly executionId?: string;
  /** Id of the Turn this run replays (eval). */
  readonly replayOf?: string;
  /** Aborts the run (graph and in-flight model calls), e.g. when the user presses Esc. */
  readonly signal?: AbortSignal | undefined;
  /** Callback to receive token streaming and tool calls in real time; may be `async`, is not awaited (#1124). */
  readonly onStream?: (event: ExecutionStreamEvent) => void;
  /** The thread's owner, read as `executionContext.ownerId` (checked by the app). */
  readonly ownerId?: string | undefined;
  /**
   * The execution's context values (#261), validated by the app: its tenant (`tenantId` keys its
   * thread and its tree) and its own fields. A new execution keeps them in its state; a resume
   * reads them back from there. Default: the tenant `"default"`, no fields.
   */
  readonly contexts?: ExecutionContextValues | undefined;
  /** Extra LangGraph `configurable` keys for the run's nodes (the framework's own keys win). */
  readonly configurable?: Readonly<Record<string, unknown>> | undefined;
}

/** What the execution kept of its data when it stopped (the record, #270 AC16). */
export interface ExecutionData {
  readonly scope: ScopeRecords;
  readonly outdatedValues: readonly OutdatedValueRecord[];
  readonly lastError: ErrorRecord | null;
  /** The execution's parallel launches (#273); absent in a run stored before them. */
  readonly launches?: readonly LaunchRecord[];
  /** Its child executions that ended (#263); absent in a run stored before them. */
  readonly children?: readonly EndedChildRecord[];
  /** The failures its side paths took (#263); absent in a run stored before them. */
  readonly handledErrors?: readonly HandledErrorRecord[];
  /** Its undoable actions (#340); absent in a run stored before them. */
  readonly compensations?: readonly CompensationEntry[];
  /** Its agents' tool calls (#395); absent in a run stored before them. */
  readonly toolCalls?: readonly ToolCallRecord[];
  /** One record per visit (#395 C3); absent in a run stored before them. */
  readonly steps?: readonly ExecutionStepRecord[];
  /** Where its request came from (#398 PR 2): a trusted mesh peer's. */
  readonly origin?: ExecutionOrigin;
}

/** How one execution (or its resume) ended for the app. Failures are thrown, not returned. */
export interface AgentExecutionOutput {
  /** A pass of the core finishes or pauses; a stop and a cancel are the app's (`ExecutionOutput`). */
  readonly status: ExecutionStatus.Finished | ExecutionStatus.Paused;
  /** The start it began at and its validated input (the thread's history line, S8). */
  readonly start: string;
  readonly startInput: unknown;
  /** Node ids in the order the execution visited them (a paused one: up to the waiting agent). */
  readonly path: readonly string[];
  /** The workflow finish it reached and the finish's output DTO. */
  readonly finish?: string;
  readonly output?: unknown;
  readonly budgetUsd: number;
  readonly cost: CostReport;
  readonly threadId: string;
  /** The tenant the execution works for (#261): with `threadId`, the key of its thread. */
  readonly tenantId: string;
  readonly turnId: string;
  readonly data: ExecutionData;
  /** What the compactions did before this execution read its thread (#120 S132), when one did. */
  readonly compacted?: readonly Compacted[];
  /** The conversation in the tracing UI (session = thread), when tracing is on. */
  readonly traceUrl?: string;
  /** The run's id (observer events, `executionContext.executionId`, its Turn, its checkpoint — a resume keeps it). */
  readonly runId: string;
  /** What a paused execution waits for: every pending pause of its tree (#267 AC1); empty otherwise. */
  readonly pending: readonly WaitingPause[];
  /** The workflow version it started on (`workflow.startedVersion`); absent in a run stored before it. */
  readonly startedVersion?: string;
}
