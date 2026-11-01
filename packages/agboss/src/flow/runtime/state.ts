import { Annotation } from "@langchain/langgraph";
import type { ExecutionBudgetRecord } from "../../budgets/execution-budgets.js";
import type { ErrorRecord } from "../../core/error-record.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { HistoryTurn, ReaderMemory } from "./history.js";
import {
  mergeBranchRecords,
  type BranchOutcomeRecord,
  type BranchRecordsUpdate,
  type LaunchRecord,
  type LaunchTicket,
} from "./launch/records.js";
import { DEFAULT_CONTEXT_VALUES, type ExecutionContextValues } from "../context/context-values.js";
import type { OutdatedValueRecord, ScopeRecords } from "./records.js";
import { mergeTokens, type PiiTokenMap } from "../../pii/tokens.js";
import type { EndedChildRecord, ChildIdentityRecord, HandledErrorRecord } from "./child-records.js";
import { mergeCompensations, type CompensationEntry } from "../compensation.js";
import type { ToolCallRecord } from "./tool-calls.js";
import type { ExecutionStepRecord } from "./step-records.js";
import type { SidePathRecord } from "./limits.js";

/**
 * The state of one v2 execution (#272 → Runtime): the path scope (one record per slot; current values
 * only, written as a whole by each visit, #271 S11), the append-only `outdatedValues` channel the
 * outdating step moves values to, the path of node ids, visits per
 * node, steps, the error an `.onError` routes on, the node chosen next, the finish and its output,
 * the launch in flight with its branches' outcome records and the launches so far (#273), plus the
 * usage, budget, memory and approval channels, a child's identity, the ended child executions and
 * the handled failures (#263). Nodes return only the keys they own.
 */

const replace = <TValue>(_previous: TValue, next: TValue): TValue => next;
const append = <TItem>(left: readonly TItem[], right: readonly TItem[]): TItem[] => [
  ...left,
  ...right,
];
const addCounts = (
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Record<string, number> => {
  const sum: Record<string, number> = { ...left };
  for (const [name, count] of Object.entries(right)) sum[name] = (sum[name] ?? 0) + count;
  return sum;
};

export const ExecutionState = Annotation.Root({
  runId: Annotation<string>({ reducer: replace, default: () => "" }),
  /** The `name` of the workflow start the execution began at. */
  start: Annotation<string>({ reducer: replace, default: () => "" }),
  /** The start's validated input (the start's scope value; internal `run.input`); checkpointed, so a resume reads it back. */
  startInput: Annotation<unknown>({ reducer: replace, default: () => ({}) }),
  /**
   * The values of the execution's contexts (#261): its tenant and its execution fields, validated
   * at `execute` and frozen; checkpointed, so a resume runs on the values it started with.
   */
  contexts: Annotation<ExecutionContextValues>({
    reducer: replace,
    default: () => DEFAULT_CONTEXT_VALUES,
  }),
  /** The workflow version the execution started on (`workflow.startedVersion`, #280); kept on resume. */
  startedVersion: Annotation<string>({ reducer: replace, default: () => "" }),
  /** When the root execution started (ISO 8601, the application's `Clock`, #401): its history's. */
  startedAt: Annotation<string>({ reducer: replace, default: () => "" }),
  /**
   * The path scope: the current value of each slot. A visit writes it whole — its new values in, what
   * they outdated out (#271) — so a slot can leave it.
   */
  scope: Annotation<ScopeRecords>({ reducer: replace, default: () => ({}) }),
  /** Values the outdating step moved out of the scope, each with its root trigger and reason (#271). */
  outdatedValues: Annotation<OutdatedValueRecord[]>({ reducer: append, default: () => [] }),
  /** Every node visited, in order (node ids = component names). */
  path: Annotation<string[]>({ reducer: append, default: () => [] }),
  /** Visits per node id in this execution (`maxVisits`). */
  visits: Annotation<Record<string, number>>({ reducer: addCounts, default: () => ({}) }),
  /** Visits of agents and routers (`maxSteps`). */
  steps: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
  /** The failure the last node's `.onError` routes on, as a plain record (survives a resume). */
  lastError: Annotation<ErrorRecord | null>({ reducer: replace, default: () => null }),
  /** The node id the last node chose; "" ends the execution. */
  next: Annotation<string>({ reducer: replace, default: () => "" }),
  /** The finish the execution ended at ("" until then) and its output DTO. */
  finish: Annotation<string>({ reducer: replace, default: () => "" }),
  output: Annotation<unknown>({ reducer: replace, default: () => undefined }),
  /** FinOps: what this execution may spend; every model call appends one record. */
  budgetUsd: Annotation<number>({ reducer: replace, default: () => Number.POSITIVE_INFINITY }),
  usage: Annotation<UsageRecord[]>({ reducer: append, default: () => [] }),
  /**
   * The execution's budgets (#261): each one's `maxSpend()` read once, at its start, kept for the
   * whole execution — a resume and a recovery count against the same amounts.
   */
  budgets: Annotation<readonly ExecutionBudgetRecord[]>({ reducer: replace, default: () => [] }),
  /** The thread's finished executions (S8), as deep as its deepest reader needs, loaded once. */
  history: Annotation<HistoryTurn[]>({ reducer: replace, default: () => [] }),
  /** What each reader remembers of them, with its compaction's summaries (#120 PR 3). */
  memory: Annotation<Record<string, ReaderMemory>>({ reducer: replace, default: () => ({}) }),
  /** The parallel launch in flight (#273 S20): written by its launching step, cleared by its join. */
  launch: Annotation<LaunchTicket | null>({ reducer: replace, default: () => null }),
  /** One outcome record per ended branch; a join reads and drops only its own launch's. */
  branchRecords: Annotation<BranchOutcomeRecord[], BranchRecordsUpdate>({
    reducer: mergeBranchRecords,
    default: () => [],
  }),
  /** Every finished launch of the execution (`result.launches`). */
  launches: Annotation<LaunchRecord[]>({ reducer: append, default: () => [] }),
  /** The approval decisions on tool calls in this execution. */
  approvals: Annotation<ApprovalRecord[]>({ reducer: append, default: () => [] }),
  /** Its agents' tool calls (#395), in the order their visits ended, each visit's in call order. */
  toolCalls: Annotation<ToolCallRecord[]>({ reducer: append, default: () => [] }),
  /** One record per visit of a node (#395 C3), in the order the visits ended (`record.steps`). */
  stepRecords: Annotation<ExecutionStepRecord[]>({ reducer: append, default: () => [] }),
  /**
   * The PII token map (#120 S38): token → value of every `replaceWithToken()` the model boundary
   * made — tokens are deterministic, so branches merge by key; kept by a pause, a resume and recovery.
   */
  piiTokens: Annotation<PiiTokenMap>({ reducer: mergeTokens, default: () => ({}) }),
  /**
   * The key of the execution's field tokens (#334) when the application sets no `pseudonymKey`:
   * made once per root execution, handed to its children — after a pause, a failover or a crash
   * another instance gives one value the same token. `null`: the application's key (or an old
   * checkpoint: the instance's).
   */
  piiKey: Annotation<string | null>({ reducer: replace, default: () => null }),
  /**
   * A child execution's own identity (#263, ADR-0022): made on its first entry, kept in its own
   * state, so a re-entry after a pause or a crash reads the same id; `null` at the root.
   */
  child: Annotation<ChildIdentityRecord | null>({ reducer: replace, default: () => null }),
  /** Every child execution that ended, as a nested record (`result.children`). */
  children: Annotation<EndedChildRecord[]>({ reducer: append, default: () => [] }),
  /** Every failure an `.onError` / `.onJoinError` side path took (`toHaveHandledError`). */
  handledErrors: Annotation<HandledErrorRecord[]>({ reducer: append, default: () => [] }),
  /** The side path the next visit is on (#656): what the budgets' exemptions read; `null` off one. */
  sidePath: Annotation<SidePathRecord | null>({ reducer: replace, default: () => null }),
  /**
   * The undoable actions that succeeded (#340): one entry per action with `compensateWith` — open
   * with a snapshot of what its undo reads, then committed or closed by its undo (an entry written
   * again moves to the end, so the closed ones are in the order their undo ended).
   */
  compensations: Annotation<CompensationEntry[]>({
    reducer: mergeCompensations,
    default: () => [],
  }),
});

export type ExecutionStateType = typeof ExecutionState.State;
export type ExecutionStateUpdate = typeof ExecutionState.Update;
