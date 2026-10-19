import type { Milliseconds } from "../units/index.js";
import type { ErrorClass } from "./ast.js";
import type {
  BuiltPath,
  ClaimsOf,
  GroupHead,
  GroupOfPath,
  PathHead,
  ReturnsOptions,
  SidePath,
  Transitions,
} from "./builder-types.js";
import type { WithClaims } from "./this-workflow-types.js";
import type { ValueOf, ValueShape } from "./dto-wrappers.js";
import type { GeneratedTypeError, JoinOutputOf, NoOutput } from "./generated-types.js";
import type { ArbiterChoice } from "./quorum-step.js";
import type {
  IsSeveral,
  Members,
  Returning,
  Same,
  ValuesLeft,
  ValuesSource,
} from "./returns-types.js";

/**
 * The types of quorums (#279): after `.toParallelAgents(…)` the launch takes `.acceptedBy(A)` /
 * `.acceptedBy(anyOf(A, B))` (then never `.join()`), and a quorum join —
 * `.joinQuorum({ min, max, deadline })`, whose `.returns(…)` is the launch's `JoinOutputs` entry
 * with every single value `optional(…)` unless `min` is the number of launched agents (one check,
 * `Min extends Count`, no arithmetic), or `.joinQuorumGroups(group(…)…, { deadline })`, whose
 * groups each name their values (checked against `JoinOutputs["<launch> group(<agents>)"]`) and
 * continue their own path.
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

/** Whether `min` counts every launched agent: then each answer is present (`Min extends Count`). */
export type IsWholeQuorum<TMin, TCount extends number> = number extends TCount
  ? false
  : number extends TMin
    ? false
    : TMin extends TCount
      ? true
      : false;

/** A single value a quorum may leave out: `optional(…)`; a list stays a list. */
type MayBeLeftOut<TValue> = TValue extends readonly unknown[] ? TValue : TValue | undefined;

/** What a quorum's counted answers give: the join's entry, singles optional unless the quorum is whole. */
export type QuorumOutput<TOutput, TWhole extends boolean> = TWhole extends true
  ? TOutput
  : [TOutput] extends [GeneratedTypeError | NoOutput]
    ? TOutput
    : IsSeveral<TOutput> extends true
      ? { readonly [K in keyof TOutput]: MayBeLeftOut<TOutput[K]> }
      : MayBeLeftOut<TOutput>;

/** The values of a quorum: its launch's `JoinOutputs` entry, singles optional (AC14). */
export interface QuorumValues<TKey extends string> extends ValuesSource {
  readonly label: "the quorum (a single answer is optional(…) unless min is every agent)";
  readonly entry: `JoinOutputs["${TKey}"]`;
  readonly takesAbout: true;
  readonly canLaunch: false;
}

type QuorumContinuation<TOutput, TKey extends string, THead extends PathHead> = [TOutput] extends [
  GeneratedTypeError,
]
  ? Returning<QuorumValues<TKey>, TOutput, THead>
  : [TOutput] extends [NoOutput]
    ? Transitions<THead>
    : Returning<QuorumValues<TKey>, ValuesLeft<TOutput>, THead>;

/** After `.joinQuorum(…)`: its `.onJoinError(…)`, then its counted answers named with `.returns(…)`. */
export type QuorumJoined<TKey extends string, THead extends PathHead, TWhole extends boolean> = {
  onJoinError<const TPath extends SidePath>(
    error: ErrorClass,
    path: TPath,
  ): QuorumJoined<TKey, WithClaims<THead, ClaimsOf<TPath>>, TWhole>;
} & QuorumContinuation<QuorumOutput<JoinOutputOf<TKey>, TWhole>, TKey, THead>;

/** After `.joinQuorumGroups(…)`: only `.onJoinError(…)` — each group continued its own path. */
export type GroupsJoined<THead extends PathHead> = BuiltPath<THead> & {
  onJoinError<const TPath extends SidePath>(
    error: ErrorClass,
    path: TPath,
  ): GroupsJoined<WithClaims<THead, ClaimsOf<TPath>>>;
};

/** A group's `.returns(…)` chain; after the first value the group may go on with `.to…(…)`. */
export interface GroupValues<TNames extends string, TGiven extends readonly unknown[]> {
  returns<const TShape extends ValueShape>(
    value: TShape,
    ...options: [options?: ReturnsOptions]
  ): GroupValues<TNames, [...TGiven, ValueOf<TShape>]> &
    Transitions<GroupHead<TNames, [...TGiven, ValueOf<TShape>]>>;
}

/** `group(A, B, …)`: its `.priority(n)` (1 is the highest), then its values. */
export interface GroupStart<TNames extends string> extends GroupValues<TNames, []> {
  priority(priority: number): GroupValues<TNames, []>;
}

/** A group continued to its own path: what `.joinQuorumGroups(…)` takes. */
export type GroupPath = BuiltPath<GroupHead<string, readonly unknown[], unknown>>;

/** `.joinQuorumGroups(…)`'s arguments: one or more groups, then its options. */
export type GroupArguments =
  readonly [GroupPath, ...GroupPath[]] | readonly [GroupPath, ...GroupPath[], QuorumGroupsOptions];

/** The `JoinOutputs` key of a group: `<launch> group(<agents as listed>)`. */
export type GroupKey<TKey extends string, TNames extends string> = `${TKey} group(${TNames})`;

type GroupValuesCheck<TOutput, TGiven extends readonly unknown[], TKey extends string> = [
  TOutput,
] extends [GeneratedTypeError]
  ? TOutput
  : Same<ValuesLeft<TOutput>, Members<TGiven>> extends true
    ? unknown
    : {
        readonly __error: `a group's .returns(…) names what its places give — see JoinOutputs["${TKey}"]`;
      };

/** One group checked against its entry; anything but a continued `group(…)` is refused. */
type GroupCheck<TKey extends string, TPath> = [GroupOfPath<TPath>] extends [never]
  ? { readonly __error: ".joinQuorumGroups(…) takes group(…).returns(…).to…(…) paths" }
  : GroupOfPath<TPath> extends GroupHead<
        infer TNames extends string,
        infer TGiven extends readonly unknown[]
      >
    ? GroupValuesCheck<JoinOutputOf<GroupKey<TKey, TNames>>, TGiven, GroupKey<TKey, TNames>>
    : never;

/** Every group of the arguments checked; the options left as they are. */
export type GroupsCheck<TKey extends string, TArgs extends readonly unknown[]> = {
  [K in keyof TArgs]: TArgs[K] extends { readonly steps: unknown }
    ? GroupCheck<TKey, TArgs[K]>
    : unknown;
};

/**
 * What an agents' launch takes besides `.join()` (#279): its arbiters, then a quorum join. After
 * `.acceptedBy(…)` only these: `.acceptedBy(…).join()` does not compile (AC12).
 */
export interface Quorums<TKey extends string, THead extends PathHead, TCount extends number> {
  acceptedBy(arbiter: ArbiterChoice): Quorums<TKey, THead, TCount>;
  joinQuorum<const TOptions extends QuorumOptions>(
    options: TOptions,
  ): QuorumJoined<TKey, THead, IsWholeQuorum<TOptions["min"], TCount>>;
  joinQuorumGroups<const TArgs extends GroupArguments>(
    ...groups: TArgs & GroupsCheck<TKey, TArgs>
  ): GroupsJoined<WithClaims<THead, ClaimsOf<TArgs[number]>>>;
}
