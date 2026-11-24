import type { Milliseconds } from "../units/index.js";
import type { ArbiterClass, ErrorClass } from "./ast.js";
import type {
  BuiltPath,
  GroupHead,
  IsGroupPath,
  PathHead,
  SidePath,
  Transitions,
} from "./builder-types.js";

/**
 * The types of quorums (#279): after `.inParallel([…])` (or `.toParallelAgents(…)`) the launch takes
 * `.arbitratedBy(A)` — one `@Arbiter` class (#1282; then never `.join()`) — and a quorum join —
 * `.joinQuorum({ min, max, deadline })`, which goes on with `.onError(…)` and a transition, or
 * `.joinQuorumGroups(group(…)…, { deadline })`, whose groups continue their own path. What the
 * counted answers give is derived by the analyser (#1270): after `.joinQuorum(…)` with `min` below
 * the agents launched a single answer is optional, and a step that requires it fails
 * `[input.missing-on-path]`.
 */

/** `.joinQuorum({ min, max, deadline })`: options are always an object (AC11). */
export interface QuorumOptions {
  /** How many counted answers are enough to go on. */
  readonly min: number;
  /** After how many counted answers to stop waiting and cancel the rest; `min` when absent. */
  readonly max?: number;
  /** How long the join waits: `seconds()`, `minutes()`, `hours()` — never a bare number. */
  readonly deadline?: Milliseconds;
}

/** `.joinQuorumGroups(…, { deadline })`: `min` / `max` do not apply to groups. */
export interface QuorumGroupsOptions {
  readonly deadline?: Milliseconds;
}

/** After `.joinQuorum(…)`: its `.onError(…)`, then one transition. */
export type QuorumJoined<THead extends PathHead> = {
  onError(error: ErrorClass, path: SidePath): QuorumJoined<THead>;
} & Transitions<THead>;

/** After `.joinQuorumGroups(…)`: only `.onError(…)` — each group continued its own path. */
export type GroupsJoined<THead extends PathHead> = BuiltPath<THead> & {
  onError(error: ErrorClass, path: SidePath): GroupsJoined<THead>;
};

/** `group(A, B, …)`: its `.priority(n)` (1 is the highest), then its own path. */
export interface GroupStart extends Transitions<GroupHead> {
  priority(priority: number): Transitions<GroupHead>;
}

/** A group continued to its own path: what `.joinQuorumGroups(…)` takes. */
export type GroupPath = BuiltPath<GroupHead>;

/** `.joinQuorumGroups(…)`'s arguments: one or more groups, then its options. */
export type GroupArguments =
  readonly [GroupPath, ...GroupPath[]] | readonly [GroupPath, ...GroupPath[], QuorumGroupsOptions];

/** One group checked: anything but a continued `group(…)` is refused. */
export type GroupCheck<TPath> =
  IsGroupPath<TPath> extends true
    ? unknown
    : { readonly __error: ".joinQuorumGroups(…) takes group(…).to…(…) paths" };

/** Every group of the arguments checked; the options left as they are. */
export type GroupsCheck<TArgs extends readonly unknown[]> = {
  [K in keyof TArgs]: TArgs[K] extends { readonly steps: unknown } ? GroupCheck<TArgs[K]> : unknown;
};

/**
 * What `.arbitratedBy(A)` of a launch of fixed branches (`.inParallel([…])`) gives (#1282): a quorum
 * join, never `.join()` (AC12) — `.joinQuorum(…)` or `.joinQuorumGroups(…)`.
 */
export interface FixedArbitratedQuorums<THead extends PathHead> {
  joinQuorum(options: QuorumOptions): QuorumJoined<THead>;
  joinQuorumGroups<const TArgs extends GroupArguments>(
    ...groups: TArgs & GroupsCheck<TArgs>
  ): GroupsJoined<THead>;
}

/**
 * What a launch of fixed branches takes besides `.join()` (#279): a quorum join as it is (every
 * answer counts), or `.arbitratedBy(A)` — one `@Arbiter` class — and then a quorum join.
 */
export interface Quorums<THead extends PathHead> extends FixedArbitratedQuorums<THead> {
  /** The one arbiter whose rule decides which answers count. */
  arbitratedBy(arbiter: ArbiterClass): FixedArbitratedQuorums<THead>;
}
