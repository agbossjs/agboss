import type { LaunchRecord } from "../flow/runtime/launch/records.js";
import type { ExecutionStatus } from "../app/types.js";
import type { ErrorRecord } from "../core/error-record.js";
import type { ApplicationBudgets } from "../budgets/execution-budgets.js";
import type { CostReport } from "../finops/usage.js";
import type { OutdatedValueRecord, ScopeRecords } from "../flow/runtime/records.js";
import type { GraphDeps } from "../graph/deps.js";
import type { Compacted } from "./compaction.js";
import type { PendingPause } from "../pause/index.js";
import type { TernRecords } from "../terns/index.js";
import type { RunTracing } from "../tracing/index.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";
import type { Clock } from "../infrastructure/clock.js";

/** Graph dependencies plus the application's budgets and the Tern store. */
export interface RunDeps<TName extends string> extends GraphDeps<TName> {
  /**
   * The application's budgets and their ledger (#261): every execution is checked and counted
   * against them; absent = a workflow run without an application (no budgets).
   */
  readonly budgets?: ApplicationBudgets | undefined;
  readonly terns: TernRecords;
  /** Compaction prompt (workflow override); default in src/prompts/compaction.ts. */
  readonly compactionPrompt?: string | undefined;
  /** Optional tracing (e.g. local Langfuse); runs are identical without it. */
  readonly tracing?: RunTracing | undefined;
  /** A new run id; random by default, deterministic in tests. */
  readonly newRunId?: () => string;
  /** The application's clock (#262): tool timeouts run on it; default the system's. */
  readonly clock?: Clock | undefined;
}

/** A stream event for real-time UI/CLI updates. */
export type RunStreamEvent =
  | { readonly kind: "textDelta"; readonly delta: string }
  | { readonly kind: "toolCall"; readonly tool: string; readonly args?: unknown };

export interface RunOptions {
  /** The run's id, made once by the app (its observer events use it too); default: a new one. */
  readonly runId?: string;
  /** Id of the Tern this run replays (eval). */
  readonly replayOf?: string;
  /** Aborts the run (graph and in-flight model calls), e.g. when the user presses Esc. */
  readonly signal?: AbortSignal | undefined;
  /** Callback to receive token streaming and tool calls in real time. */
  readonly onStream?: (event: RunStreamEvent) => void;
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
}

/** How one execution (or its resume) ended for the app. Failures are thrown, not returned. */
export interface AgentExecutionOutput {
  readonly status: ExecutionStatus;
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
  readonly ternId: string;
  readonly data: ExecutionData;
  /** Conversation memory: what this turn compacted, when it did. */
  readonly compacted?: Compacted;
  /** The conversation in the tracing UI (session = thread), when tracing is on. */
  readonly traceUrl?: string;
  /** The run's id (observer events, `executionContext.executionId`, its Tern, its checkpoint — a resume keeps it). */
  readonly runId: string;
  /** Present only when paused: the tool call waiting for an approval. */
  readonly pending?: PendingPause;
  /** The workflow version it started on (`workflow.startedVersion`); absent in a run stored before it. */
  readonly startedVersion?: string;
}
