import type { ErrorRecord } from "../../../core/error-record.js";
import type { FailurePolicy } from "../../decorators/router.js";
import type { NodeValue } from "../scope.js";

/**
 * What a parallel launch keeps in the execution's state (#273 S20): the launch in flight — its id
 * and the branches it dispatched, each a ticket — and one outcome record per branch that ended. A
 * branch's error is a record, never an exception through LangGraph, so the join always runs and can
 * take it into `.onJoinError(…)`. Everything is plain JSON: it survives a serialising checkpointer.
 */

/** How a branch of a launch ended. */
export enum BranchStatus {
  /** It ran to its end: its value goes to the join. */
  Finished = "finished",
  /** It failed: the launch fails (`FailFast`, or anything but a step failure under `Skip`). */
  Failed = "failed",
  /** It failed on its own step under `FailurePolicy.Skip` (S21): it drops out of the join. */
  Skipped = "skipped",
  /** A sibling failed first: the launch's `AbortController` stopped it, or it never started. */
  Cancelled = "cancelled",
}

/**
 * What a quorum made of a finished branch's answer (#279 S26): `Counted` — it took a place (only
 * these enter the path scope); `Rejected` — an arbiter of its `.acceptedBy(…)` chain said no;
 * `Surplus` — accepted after the quorum was already decided (`max` taken, a group won, the deadline
 * passed).
 */
export enum BranchVerdict {
  /** It took a place; its value enters the path scope. */
  Counted = "counted",
  /** An arbiter rejected it. */
  Rejected = "rejected",
  /** Accepted after the quorum was decided. */
  Surplus = "surplus",
}

/** One branch a launch dispatched: which node, which copy or item, and its counters. */
export interface BranchTicket {
  /** Its position in the launch, from 0: listed order, or the item's index — the join's order. */
  readonly index: number;
  /** The node it runs: the component's `name`. */
  readonly node: string;
  /** Its id in `result.path`, traces and events: `critic-agent#2` for a copy, else the `name`. */
  readonly nodeId: string;
  /** Which copy of a repeated agent, from 1; `1` when the target is listed once. */
  readonly copyNumber: number;
  /** The item's index of a per-item launch, from 0. */
  readonly itemIndex?: number;
  /** The pass through `node` this launch is — the same for every copy and item (`maxVisits`). */
  readonly visitNumber: number;
  /** The execution's steps before this branch's visit (`maxSteps`), counted in dispatch order. */
  readonly stepsBefore: number;
  /** Its route's failure policy (a router's launch); `FailFast` everywhere else. */
  readonly failure: FailurePolicy;
}

/** The launch in flight: written by the launching step, read by its branches and its join. */
export interface LaunchTicket {
  /** `${executionId}:${nodeId}:${visitNumber}` of the launching step (S20). */
  readonly launchId: string;
  /** The launch of the graph it runs (`RuntimeLaunch.key`). */
  readonly key: string;
  /** The launching node and its visit. */
  readonly launcher: string;
  readonly visitNumber: number;
  readonly maxConcurrency?: number;
  /** A quorum's deadline (#279 S26): epoch milliseconds on the application's `Clock`, set at dispatch. */
  readonly deadlineAt?: number;
  /** How many items (or listed targets) there were, and how many were launched. */
  readonly items: number;
  readonly taken: number;
  readonly branches: readonly BranchTicket[];
}

/** How one branch ended: its value, what it read, or its error as a plain record. */
export interface BranchOutcomeRecord {
  readonly launchId: string;
  /** The ticket's `index`. */
  readonly index: number;
  readonly status: BranchStatus;
  readonly value?: NodeValue;
  /** The `valueId`s it read (a per-item run's item counts as its list). */
  readonly read: readonly string[];
  readonly error?: ErrorRecord;
  /** Under a quorum (#279): what became of its answer, and its place in the counting order. */
  readonly verdict?: BranchVerdict;
  readonly acceptedSequence?: number;
  /** The arbiters that rejected it (every one of an `anyOf(…)`), by `name`. */
  readonly rejectedBy?: readonly string[];
}

/** What a node writes to the outcome records: a branch adds its own, a join drops its launch's. */
export interface BranchRecordsUpdate {
  readonly add?: readonly BranchOutcomeRecord[];
  /** The launch id whose records the join has read. */
  readonly drop?: string;
}

/** Adds and drops outcome records (a join drops only its own launch's). */
export function mergeBranchRecords(
  records: readonly BranchOutcomeRecord[],
  update: BranchRecordsUpdate,
): BranchOutcomeRecord[] {
  const kept = records.filter((record) => record.launchId !== update.drop);
  return [...kept, ...(update.add ?? [])];
}

/** One branch of a finished launch, as the execution reports it (`result.launches`). */
export interface BranchRecord {
  /** `critic-agent#2` for a copy, the node's `name` otherwise. */
  readonly nodeId: string;
  /** Which copy of a repeated target, from 1. */
  readonly copyNumber: number;
  /** The item's index of a per-item launch, from 0. */
  readonly itemIndex?: number;
  /** How it ended. */
  readonly status: BranchStatus;
  /** A failed, skipped or cancelled branch's error (S21: a skipped one's stays visible). */
  readonly error?: ErrorRecord;
  /** Under a quorum (#279): counted, rejected or surplus — a cancelled branch has none. */
  readonly verdict?: BranchVerdict;
  /** A counted answer's place in the counting order, from 1 (the join's order). */
  readonly acceptedSequence?: number;
  /** The arbiters that rejected its answer, by `name`. */
  readonly rejectedBy?: readonly string[];
}

/** The `group(…)` of `.joinQuorumGroups(…)` that won (#279): its agents as listed, its priority. */
export interface QuorumGroupRecord {
  /** Its agents by `name`, as listed (a repeat is one more copy). */
  readonly agents: readonly string[];
  /** Its priority (1 is the highest); absent when the group has none. */
  readonly priority?: number;
}

/**
 * One launch of an execution (`result.launches`): its id, how many items (a per-item launch) or
 * listed targets there were and how many were launched — `{ items: 200, taken: 50 }` after
 * `maxItems: 50`, or the `OnDemand` routes a router left out — and how each branch ended.
 */
export interface LaunchRecord {
  /** `${executionId}:${nodeId}:${visitNumber}` of the launching step. */
  readonly launch: string;
  /** The list's length (a per-item launch), or how many targets the launch lists. */
  readonly items: number;
  /** How many branches were launched: at most `maxItems`; a router's `OnDemand` "no" left out. */
  readonly taken: number;
  /** Every launched branch, in the join's order. */
  readonly branches: readonly BranchRecord[];
  /** A quorum's join (#279): whether it was reached. */
  readonly isQuorumReached?: boolean;
  /** `.joinQuorumGroups(…)`: the group that won. */
  readonly group?: QuorumGroupRecord;
}
