import type { ChildStepOptions } from "./child-placement.js";
import type { Class } from "../components/injection.js";
import type { ErrorClass, NodeKind } from "./ast.js";
import type { KindLabel, PathHead, SidePath, TargetCheck, Transitions } from "./builder-types.js";
import type { Quorums } from "./quorum-types.js";
import type { ClassOf, TargetRef } from "./target-ref.js";

/**
 * The types of a parallel launch (#273): `.toParallelAgents(A, B, …, { maxConcurrency, maxItems })`,
 * `.toParallelActions(…)` and `.toParallelWorkflows(W, { maxConcurrency, maxItems })` (#263, one
 * child per item) take targets of their kind only and are followed by `.join()` only (a path
 * that stops at a launch is not a path); what the join gives is derived from the branches' outputs
 * (#1270), so after it the path goes on with `.onError(…)` and a transition.
 */

/** `{ maxConcurrency, maxItems }` — the last argument of a parallel launch. */
export interface LaunchOptions {
  /** At most this many branches in progress at once; a limit only, it never changes the result. */
  readonly maxConcurrency?: number;
  /** A per-item launch runs its target for the first `maxItems` items (`[launch.max-items-required]`). */
  readonly maxItems?: number;
}

/**
 * `{ maxConcurrency, maxItems }` of `.toParallelWorkflows(W, …)` (#263): a child per item, so
 * `maxItems` is always set.
 */
export interface WorkflowLaunchOptions extends LaunchOptions, ChildStepOptions {
  readonly maxItems: number;
}

/** A launch's arguments: one or more component classes, then its options. */
export type LaunchArguments =
  readonly [Class, ...Class[]] | readonly [Class, ...Class[], LaunchOptions];

/** Each target checked like a transition's: its kind, and an input the paths into it can fill. */
export type LaunchCheck<TArgs extends readonly unknown[], TKind extends NodeKind> = {
  [K in keyof TArgs]: TArgs[K] extends Class
    ? TargetCheck<TArgs[K], TKind, KindLabel<TKind>>
    : unknown;
};

/** Whether an output is several values at once (a tuple: a start whose `input` is a map). */
export type IsSeveral<TOutput> = TOutput extends readonly unknown[]
  ? number extends TOutput["length"]
    ? false
    : true
  : false;

/** The value the chain carries last: the step's output, a start's last field. */
export type LastValue<TValue> =
  IsSeveral<TValue> extends true
    ? TValue extends readonly [...unknown[], infer TLast]
      ? TLast
      : never
    : TValue;

/** One target right after a step that gives a list: one run per item of that list. */
export type IsPerItem<TTargets extends readonly unknown[], TValue> = TTargets extends readonly [
  unknown,
]
  ? [LastValue<TValue>] extends [never]
    ? false
    : [LastValue<TValue>] extends [readonly unknown[]]
      ? true
      : false
  : false;

/** After a launch: only `.join()`. */
export interface Launched<THead extends PathHead> {
  join(): Joined<THead>;
}

/** After an agents' launch: `.join()`, or its arbiters and a quorum join (#279). */
export type AgentsLaunched<THead extends PathHead> = Launched<THead> & Quorums<THead>;

/** `.onError(E, toAction(X)…)` right after `.join()`: a failed branch, a limit in a branch. */
export interface JoinErrorHandling<THead extends PathHead> {
  onError(error: ErrorClass, path: SidePath): Joined<THead>;
}

/** After `.join()`: its `.onError(…)`, then one transition — its values are derived (#1270). */
export type Joined<THead extends PathHead> = JoinErrorHandling<THead> & Transitions<THead>;

/** A child workflow launched per item (#263): the chain's last value is a list, the child checked. */
export type ChildLaunchCheck<TClass extends Class, TValue> =
  IsPerItem<readonly [TClass], TValue> extends true
    ? TargetCheck<TClass, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>
    : {
        readonly __error: "toParallelWorkflows(W, …) runs one child per item — the step before it gives a list";
      };

/** The launches a step's values (`TValue`, the chain's last one per item) may lead into. */
export interface Launches<TValue, THead extends PathHead> {
  toParallelAgents<const TArgs extends LaunchArguments>(
    ...targets: TArgs & LaunchCheck<TArgs, NodeKind.Agent>
  ): AgentsLaunched<THead>;
  toParallelActions<const TArgs extends LaunchArguments>(
    ...targets: TArgs & LaunchCheck<TArgs, NodeKind.Action>
  ): Launched<THead>;
  /** One child execution of `W` per item of the list (#263), at most `maxConcurrency` at once. */
  toParallelWorkflows<const TRef extends TargetRef>(
    workflow: TRef & ChildLaunchCheck<ClassOf<TRef>, TValue>,
    options: WorkflowLaunchOptions,
  ): Launched<THead>;
}

/** A router's launch (`.toRouter(R).toParallelAgents(…)`): agents only, never per item. */
export interface RouterLaunches<THead extends PathHead> {
  toParallelAgents<const TArgs extends LaunchArguments>(
    ...targets: TArgs & LaunchCheck<TArgs, NodeKind.Agent>
  ): AgentsLaunched<THead>;
}
