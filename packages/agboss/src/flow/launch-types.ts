import type { Class } from "../components/injection.js";
import type { LimitError } from "../core/error-families/limit-errors.js";
import type { ArbiterClass, ErrorClass, NodeKind } from "./ast.js";
import type {
  BuiltPath,
  KindLabel,
  PathHead,
  SideHead,
  SidePath,
  StartOfPath,
  TargetCheck,
  Transitions,
} from "./builder-types.js";
import type { KindOf } from "./generated-types.js";
import type { RoutesOf } from "./route-types.js";
import type { Quorums, QuorumJoined, QuorumOptions } from "./quorum-types.js";
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
export interface WorkflowLaunchOptions extends LaunchOptions {
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

/** After an agents' launch or `.inParallel([…])`: `.join()`, or its arbiter and a quorum join (#279, #1282). */
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

/** `{ maxConcurrency }` — the second argument of `.inParallel([…], options)` (#1279). */
export interface ParallelOptions {
  /** At most this many branches in progress at once; a limit only, it never changes the result. */
  readonly maxConcurrency?: number | undefined;
}

/** `{ takeFirst, maxConcurrency }` of `.forEachItem(step, options)` (#1280): the first items run, the rest are dropped, recorded. */
export interface TakeFirstOptions {
  readonly takeFirst: number;
  readonly maxItems?: never;
  readonly maxConcurrency?: number | undefined;
}

/** `{ maxItems, maxConcurrency }`: a longer list throws `LimitError.Items`, handled after the join. */
export interface MaxItemsOptions {
  readonly maxItems: number;
  readonly takeFirst?: never;
  readonly maxConcurrency?: number | undefined;
}

/** `.forEachItem(step, options)` (#1280): exactly one bound — `maxItems` or `takeFirst`. */
export type ForEachItemOptions = TakeFirstOptions | MaxItemsOptions;

/** The errors a class catches: what its constructor makes (a family's constructor carries its variants' too). */
export type ErrorInstance<TError> = TError extends abstract new (
  ...args: never[]
) => infer TInstance
  ? TInstance
  : never;

/** After the join of a `{ maxItems }` launch: only `.onError(…)` until one catches `LimitError.Items` (`TNeedsItemsError`). */
export interface NeedsItemsHandler<THead extends PathHead> {
  onError<const TError extends ErrorClass>(
    error: TError,
    path: SidePath,
  ): [LimitError.Items] extends [ErrorInstance<TError>] ? Joined<THead> : NeedsItemsHandler<THead>;
}

/** After the quorum join of a `{ maxItems }` launch: only `.onError(…)` until one catches `LimitError.Items`. */
export interface NeedsItemsQuorumHandler<THead extends PathHead> {
  onError<const TError extends ErrorClass>(
    error: TError,
    path: SidePath,
  ): [LimitError.Items] extends [ErrorInstance<TError>]
    ? QuorumJoined<THead>
    : NeedsItemsQuorumHandler<THead>;
}

/**
 * What `.arbitratedBy(A)` after `.forEachItem(…)` gives (#1282): `.joinQuorum(…)` only — every item
 * runs the same target, so there are no groups to tell apart. With `TNeedsItemsError` (a
 * `{ maxItems }` launch) the join goes on with `.onError(LimitError.Items, …)` first.
 */
export interface PerItemArbitratedQuorums<
  THead extends PathHead,
  TNeedsItemsError extends boolean = false,
> {
  joinQuorum(
    options: QuorumOptions,
  ): TNeedsItemsError extends true ? NeedsItemsQuorumHandler<THead> : QuorumJoined<THead>;
}

/** After a `{ takeFirst }` launch: `.join()`, a quorum join, or `.arbitratedBy(A)` and then a quorum join. */
export interface PerItemLaunched<
  THead extends PathHead,
  TNeedsItemsError extends boolean = false,
> extends PerItemArbitratedQuorums<THead, TNeedsItemsError> {
  arbitratedBy(arbiter: ArbiterClass): PerItemArbitratedQuorums<THead, TNeedsItemsError>;
}

/** After a `{ takeFirst }` launch (nothing throws): `.join()` too. */
export type TakeFirstLaunched<THead extends PathHead> = Launched<THead> & PerItemLaunched<THead>;

/** After a `{ maxItems }` launch: `.join()` or a quorum join, then the mandatory `.onError(LimitError.Items, …)`. */
export interface ItemsLaunched<THead extends PathHead> extends PerItemLaunched<THead, true> {
  join(): NeedsItemsHandler<THead>;
}

/** What a branch of a parallel step may start with: an agent, an action, a question role, a child workflow — or a router, which only `chooseMany([…])` completes. */
export type BranchKind =
  NodeKind.Agent | NodeKind.Action | NodeKind.Question | NodeKind.Workflow | NodeKind.Router;

/** `unknown` when the branch starts with a kind a parallel step runs, else a readable error. */
export type BranchCheck<TPath> = [StartOfPath<TPath>] extends [never]
  ? unknown
  : [StartOfPath<TPath>] extends [Class]
    ? [KindOf<InstanceType<StartOfPath<TPath>>>] extends [never]
      ? unknown
      : [KindOf<InstanceType<StartOfPath<TPath>>>] extends [BranchKind]
        ? unknown
        : {
            readonly __error: "a branch is toAgent(…), toAction(…), toExternalTask(…), toWorkflow(…) or toRouter(…).chooseMany([…])";
          }
    : unknown;

/** Each branch of `.inParallel([…])` checked. */
export type BranchesCheck<TBranches extends readonly unknown[]> = {
  [K in keyof TBranches]: BranchCheck<TBranches[K]>;
};

/** `unknown` when a branch of `chooseMany([…])` is one of the router's routes, else a readable error. */
export type ChoicesCheck<TBranches extends readonly unknown[], TInstance> = {
  [K in keyof TBranches]: [RoutesOf<TInstance>] extends [never]
    ? unknown
    : [StartOfPath<TBranches[K]>] extends [never]
      ? unknown
      : [StartOfPath<TBranches[K]>] extends [RoutesOf<TInstance>]
        ? unknown
        : { readonly __error: "a branch of chooseMany([…]) is one of the router's routes" };
};

/** `toRouter(R).chooseMany([…])` (#1279b): the branches the router picks among, in a branch of `.inParallel([…])`. */
export interface ChooseMany<THead extends PathHead, TInstance> {
  chooseMany<const TBranches extends readonly [SidePath, ...SidePath[]]>(
    branches: TBranches & BranchesCheck<TBranches> & ChoicesCheck<TBranches, TInstance>,
  ): BuiltPath<THead>;
}

/** A router's `chooseMany` stands in a side path only. */
export type ChooseManyOf<THead extends PathHead, TInstance> = THead extends SideHead
  ? ChooseMany<THead, TInstance>
  : unknown;

/** `.forEachItem(…)` stands after a step that gives a list. */
export type ItemsCheck<TValue> = [LastValue<TValue>] extends [never]
  ? {
      readonly __error: "forEachItem(step, …) runs once per item — the step before it gives a list";
    }
  : [LastValue<TValue>] extends [readonly unknown[]]
    ? unknown
    : {
        readonly __error: "forEachItem(step, …) runs once per item — the step before it gives a list";
      };

/** The parallel launches of #1279 and #1280: `.inParallel([…branches])`, `.forEachItem(step, options)`. */
export interface ParallelLaunches<TValue, THead extends PathHead> {
  /**
   * Branches of any kind at once (#1279): `toAgent(A)`, `toAction(X)`, `toExternalTask(Q)`,
   * `toWorkflow(W)`, each with an optional `.onError(E, skip())`; followed by `.join()`.
   */
  inParallel<const TBranches extends readonly [SidePath, ...SidePath[]]>(
    branches: TBranches & BranchesCheck<TBranches>,
    options?: ParallelOptions,
  ): AgentsLaunched<THead>;
  /** One run of `step` per item of the list the step before gives (#1280). */
  forEachItem<const TStep extends SidePath>(
    step: TStep & BranchCheck<TStep> & ItemsCheck<TValue>,
    options: TakeFirstOptions,
  ): TakeFirstLaunched<THead>;
  forEachItem<const TStep extends SidePath>(
    step: TStep & BranchCheck<TStep> & ItemsCheck<TValue>,
    options: MaxItemsOptions,
  ): ItemsLaunched<THead>;
}

/** The launches a step's values (`TValue`, the chain's last one per item) may lead into. */
export interface Launches<TValue, THead extends PathHead> extends ParallelLaunches<TValue, THead> {
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
