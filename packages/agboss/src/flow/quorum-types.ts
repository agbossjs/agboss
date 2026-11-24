import type { Milliseconds, WorkingDuration } from "../units/index.js";
import type { Class } from "../components/injection.js";
import type { ArbiterClass, ErrorClass } from "./ast.js";
import type { BuiltPath, PathHead, SidePath, Transitions } from "./builder-types.js";

/**
 * The types of quorums (#279): after `.inParallel([…])` (or `.toParallelAgents(…)`) the launch takes
 * `.arbitratedBy(A)` — one `@Arbiter` class (#1282; then never `.join()`) — and a quorum join —
 * `.joinQuorum({ min, max, deadline })`, which goes on with `.onError(…)` and a transition, or
 * `.joinQuorumGroups({ deadline })` and its `.onGroup([…], options?, subPath)`s, whose groups continue
 * their own path (#1284). What the
 * counted answers give is derived by the analyser (#1270): after `.joinQuorum(…)` with `min` below
 * the agents launched a single answer is optional, and a step that requires it fails
 * `[input.missing-on-path]`.
 */

/**
 * How long a quorum join waits (#1306): a plain duration (`seconds()`, `minutes()`, `hours()` —
 * never a bare number), or working time (`workDays()`, `workHours()`, `workMin()`) with the
 * `@WorkingCalendar` class that counts it — `calendar` is required with working time and is
 * refused beside a plain duration.
 */
export type QuorumDeadline =
  | { readonly deadline?: Milliseconds | undefined; readonly calendar?: undefined }
  | { readonly deadline: WorkingDuration; readonly calendar: Class };

/** `.joinQuorum({ min, max, deadline })`: options are always an object (AC11). */
export type QuorumOptions = {
  /** How many counted answers are enough to go on. */
  readonly min: number;
  /** After how many counted answers to stop waiting and cancel the rest; `min` when absent. */
  readonly max?: number;
} & QuorumDeadline;

/** `.joinQuorumGroups({ deadline })`: `min` / `max` do not apply to groups. */
export type QuorumGroupsOptions = QuorumDeadline;

/** `.onGroup([…], options, subPath)`: how the group ranks among the others. */
export interface QuorumGroupOptions {
  /** 1 is the highest; a group waits while a higher one can still complete. None: equal to the others. */
  readonly priority?: number | undefined;
}

/** After `.joinQuorum(…)`: its `.onError(…)`, then one transition. */
export type QuorumJoined<THead extends PathHead> = {
  onError(error: ErrorClass, path: SidePath): QuorumJoined<THead>;
} & Transitions<THead>;

/** What `.onGroup(…)` takes: one or more classes of the launch, then its optional options and the group's own path. */
export interface OnGroup<TNext> {
  onGroup(targets: readonly [Class, ...Class[]], path: SidePath): TNext;
  onGroup(
    targets: readonly [Class, ...Class[]],
    options: QuorumGroupOptions,
    path: SidePath,
  ): TNext;
}

/** After the first `.onGroup(…)`: a path (each group continued its own), more groups; `.onError(…)` is no more. */
export type GroupsJoined<THead extends PathHead> = BuiltPath<THead> & OnGroup<GroupsJoined<THead>>;

/**
 * After `.joinQuorumGroups({ deadline })`: not a path yet — `.onError(E, …)` takes the join's failure
 * (only here, before the first group), and at least one `.onGroup(…)` completes it (#1284).
 */
export interface GroupsJoining<THead extends PathHead> extends OnGroup<GroupsJoined<THead>> {
  onError(error: ErrorClass, path: SidePath): GroupsJoining<THead>;
}

/**
 * What `.arbitratedBy(A)` of a launch of fixed branches (`.inParallel([…])`) gives (#1282): a quorum
 * join, never `.join()` (AC12) — `.joinQuorum(…)` or `.joinQuorumGroups(…)`.
 */
export interface FixedArbitratedQuorums<THead extends PathHead> {
  joinQuorum(options: QuorumOptions): QuorumJoined<THead>;
  joinQuorumGroups(options?: QuorumGroupsOptions): GroupsJoining<THead>;
}

/**
 * What a launch of fixed branches takes besides `.join()` (#279): a quorum join as it is (every
 * answer counts), or `.arbitratedBy(A)` — one `@Arbiter` class — and then a quorum join.
 */
export interface Quorums<THead extends PathHead> extends FixedArbitratedQuorums<THead> {
  /** The one arbiter whose rule decides which answers count. */
  arbitratedBy(arbiter: ArbiterClass): FixedArbitratedQuorums<THead>;
}
