import { Annotation } from "@langchain/langgraph";
import type { ErrorRecord } from "../../core/error-record.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { HistoryTurn } from "./history.js";
import {
  mergeBranchRecords,
  type BranchOutcomeRecord,
  type BranchRecordsUpdate,
  type LaunchRecord,
  type LaunchTicket,
} from "./launch/records.js";
import type { OutdatedValueRecord, ScopeRecords } from "./records.js";

/**
 * The state of one v2 execution (#272 → Runtime): the path scope (one record per slot; current values
 * only, written as a whole by each visit, #271 S11), the append-only `outdatedValues` channel the
 * outdating step moves values to, the path of node ids, visits per
 * node, steps, the error an `.onError` routes on, the node chosen next, the finish and its output,
 * the launch in flight with its branches' outcome records and the launches so far (#273), plus the
 * usage, budget, memory and approval channels. Nodes return only the keys they own.
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
  /** The workflow version the execution started on (`workflow.startedVersion`, #280); kept on resume. */
  startedVersion: Annotation<string>({ reducer: replace, default: () => "" }),
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
  /** The workflow's spend today before this execution (read once, at the first working node). */
  daySpentBeforeRunUsd: Annotation<number | null>({ reducer: replace, default: () => null }),
  /** The thread's finished executions (S8) and its compaction summaries, loaded once. */
  history: Annotation<HistoryTurn[]>({ reducer: replace, default: () => [] }),
  summaries: Annotation<string[]>({ reducer: replace, default: () => [] }),
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
});

export type ExecutionStateType = typeof ExecutionState.State;
export type ExecutionStateUpdate = typeof ExecutionState.Update;
