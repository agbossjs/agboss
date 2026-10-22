import type { CompensationEntry } from "../flow/compensation.js";
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
import type { TernRecords } from "../terns/index.js";
import type { ExecutionTracing } from "../tracing/index.js";
import type { ExecutionContextValues } from "../flow/context/context-values.js";

/** Graph dependencies plus the application's budgets and the Tern store. */
export interface AgentExecutionDeps<TName extends string> extends GraphDeps<TName> {
  /**
   * The application's budgets and their ledger (#261): every execution is checked and counted
   * against them; absent = a workflow run without an application (no budgets).
   */
  readonly budgets?: ApplicationBudgets | undefined;
  readonly terns: TernRecords;
  /** Optional tracing (e.g. local Langfuse); runs are identical without it. */
  readonly tracing?: ExecutionTracing | undefined;
}

/** A stream event for real-time UI/CLI updates. */
export type ExecutionStreamEvent =
  | { readonly kind: "textDelta"; readonly delta: string }
  | { readonly kind: "toolCall"; readonly tool: string; readonly args?: unknown };

export interface AgentExecutionOptions {
  /** The execution's id, made once by the app (its observer events use it too); default: a new one. */
  readonly executionId?: string;
  /** Id of the Tern this run replays (eval). */
  readonly replayOf?: string;
  /** Aborts the run (graph and in-flight model calls), e.g. when the user presses Esc. */
  readonly signal?: AbortSignal | undefined;
  /** Callback to receive token streaming and tool calls in real time. */
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
  /** What the compactions did before this execution read its thread (#120 S132), when one did. */
  readonly compacted?: readonly Compacted[];
  /** The conversation in the tracing UI (session = thread), when tracing is on. */
  readonly traceUrl?: string;
  /** The run's id (observer events, `executionContext.executionId`, its Tern, its checkpoint — a resume keeps it). */
  readonly runId: string;
  /** What a paused execution waits for: every pending pause of its tree (#267 AC1); empty otherwise. */
  readonly pending: readonly WaitingPause[];
  /** The workflow version it started on (`workflow.startedVersion`); absent in a run stored before it. */
  readonly startedVersion?: string;
}
