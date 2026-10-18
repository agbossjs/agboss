import type { Class } from "../components/injection.js";
import type { ErrorClass, NodeKind } from "./ast.js";
import type { KindLabel, PathHead, SidePath, TargetCheck, Transitions } from "./builder-types.js";
import type { GeneratedTypeError, JoinOutputOf, NameOf, NoOutput } from "./generated-types.js";
import type { IsSeveral, JoinValues, Returning, ValuesLeft } from "./returns-types.js";

/**
 * The types of a parallel launch (#273): `.toParallelAgents(A, B, …, { maxConcurrency, maxItems })`
 * and `.toParallelActions(…)` take targets of their kind only, are followed by `.join()` only (a path
 * that stops at a launch is not a path), and the join names what the branches give with
 * `.returns(…)` — checked against its generated `JoinOutputs` entry, keyed by the launch as written
 * (`toParallelAgents(researcher-agent, critic-agent, critic-agent)`, a router's launch prefixed by
 * its name, a per-item launch suffixed ` per item`). A join whose actions give nothing goes on with
 * `.to…(…)` at once, and nothing but `.onJoinError(…)` stands between a join and its values.
 */

/** `{ maxConcurrency, maxItems }` — the last argument of a parallel launch. */
export interface LaunchOptions {
  /** At most this many branches in progress at once; a limit only, it never changes the result. */
  readonly maxConcurrency?: number;
  /** A per-item launch runs its target for the first `maxItems` items (`[launch.max-items-required]`). */
  readonly maxItems?: number;
}

/** A launch's arguments: one or more component classes, then its options. */
export type LaunchArguments =
  readonly [Class, ...Class[]] | readonly [Class, ...Class[], LaunchOptions];

/** The targets of the arguments: every class, the options left out. */
export type TargetsOf<TArgs extends readonly unknown[]> = TArgs extends readonly [
  ...infer TTargets,
  infer TLast,
]
  ? TLast extends Class
    ? TArgs
    : TTargets
  : TArgs;

/** Each target checked like a transition's: its kind, and an input the paths into it can fill. */
export type LaunchCheck<TArgs extends readonly unknown[], TKind extends NodeKind> = {
  [K in keyof TArgs]: TArgs[K] extends Class
    ? TargetCheck<TArgs[K], TKind, KindLabel<TKind>>
    : unknown;
};

/** The names of the targets, as listed: `researcher-agent, critic-agent, critic-agent`. */
type TargetNames<TTargets extends readonly unknown[]> = TTargets extends readonly [
  infer TFirst extends Class,
  ...infer TRest,
]
  ? TRest extends readonly []
    ? NameOf<InstanceType<TFirst>>
    : `${NameOf<InstanceType<TFirst>>}, ${TargetNames<TRest>}`
  : never;

/** The value the chain carries last: the `.returns(…)` right before the launch. */
type LastValue<TValue> =
  IsSeveral<TValue> extends true
    ? TValue extends readonly [...unknown[], infer TLast]
      ? TLast
      : never
    : TValue;

/** One target right after `.returns(listOf(XDto))`: one run per item of that list. */
export type IsPerItem<TTargets extends readonly unknown[], TValue> = TTargets extends readonly [
  unknown,
]
  ? [LastValue<TValue>] extends [never]
    ? false
    : [LastValue<TValue>] extends [readonly unknown[]]
      ? true
      : false
  : false;

/** The key of a launch's `JoinOutputs` entry, as the generator writes it. */
export type LaunchKey<
  TCall extends string,
  TTargets extends readonly unknown[],
  TPerItem extends boolean,
  TPrefix extends string,
> = `${TPrefix}${TCall}(${TargetNames<TTargets>})${TPerItem extends true ? " per item" : ""}`;

/** After a launch: only `.join()`. */
export interface Launched<TKey extends string, THead extends PathHead> {
  join(): Joined<TKey, THead>;
}

/** `.onJoinError(E, toAction(X)…)` right after `.join()`: a failed branch, a limit in a branch. */
export interface JoinErrorHandling<TKey extends string, THead extends PathHead> {
  onJoinError(error: ErrorClass, path: SidePath): Joined<TKey, THead>;
}

/** What follows a join: its values named with `.returns(…)`, or — when it gives none — `.to…(…)`. */
type JoinContinuation<TOutput, TKey extends string, THead extends PathHead> = [TOutput] extends [
  GeneratedTypeError,
]
  ? Returning<JoinValues<TKey>, TOutput, THead>
  : [TOutput] extends [NoOutput]
    ? Transitions<THead>
    : Returning<JoinValues<TKey>, ValuesLeft<TOutput>, THead>;

/** After `.join()`. */
export type Joined<TKey extends string, THead extends PathHead> = JoinErrorHandling<TKey, THead> &
  JoinContinuation<JoinOutputOf<TKey>, TKey, THead>;

/** The launches a step's values (`TValue`, the chain's last one per item) may lead into. */
export interface Launches<TValue, THead extends PathHead> {
  toParallelAgents<const TArgs extends LaunchArguments>(
    ...targets: TArgs & LaunchCheck<TArgs, NodeKind.Agent>
  ): Launched<
    LaunchKey<"toParallelAgents", TargetsOf<TArgs>, IsPerItem<TargetsOf<TArgs>, TValue>, "">,
    THead
  >;
  toParallelActions<const TArgs extends LaunchArguments>(
    ...targets: TArgs & LaunchCheck<TArgs, NodeKind.Action>
  ): Launched<
    LaunchKey<"toParallelActions", TargetsOf<TArgs>, IsPerItem<TargetsOf<TArgs>, TValue>, "">,
    THead
  >;
}

/** A router's launch (`.toRouter(R).toParallelAgents(…)`): agents only, never per item. */
export interface RouterLaunches<TName extends string, THead extends PathHead> {
  toParallelAgents<const TArgs extends LaunchArguments>(
    ...targets: TArgs & LaunchCheck<TArgs, NodeKind.Agent>
  ): Launched<LaunchKey<"toParallelAgents", TargetsOf<TArgs>, false, `${TName}.`>, THead>;
}
