import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";

/**
 * The graph of a v2 workflow as data (#272 → The AST): `@Workflow({ flow })` holds one `FlowPath`
 * per path. The builder (`builder.ts`) writes it; the analyser (PR 2) and the runtime (PR 4) read it.
 * Parallel launches and their joins (#273) are steps too; a child workflow (#263) is a node of kind
 * `Workflow`, entered by `.toWorkflow(W)` (a `ToStep`) or launched per item by
 * `.toParallelWorkflows(W, …)` (a `LaunchStep`); a quorum (#279) is a join that counts the answers
 * its launch's arbiter accepts (`LaunchStep.arbitratedBy`, `JoinStep.quorum`).
 */

/** What a node of the graph is. The values are the kind suffixes of component names. */
export enum NodeKind {
  Start = "workflow-start",
  Finish = "workflow-finish",
  Agent = "agent",
  Action = "action",
  Router = "router",
  Workflow = "workflow",
  /** A question role's step (#659): `.toExternalTask(Role)` — it pauses on the role's channel. */
  Question = "question",
}

/** What a step of a path does. */
export enum StepKind {
  To = "to",
  Switch = "switch",
  /** `.toOneOf([…branches])` (#1275): the DTO-free branching of a `oneOf(…)` output. */
  OneOf = "one-of",
  /** `.onFinish(ChildFinish, subPath)` (#1275b): one finish of the child workflow the step before is. */
  OnFinish = "on-finish",
  ChooseOne = "choose-one",
  OnError = "on-error",
  /**
   * `.toParallelAgents(…)` / `.toParallelActions(…)` (#273), `.toParallelWorkflows(W, …)` (#263):
   * branches launched at once.
   */
  Launch = "launch",
  /** `.join()` after a launch, with its `.onError(…)` handlers. */
  Join = "join",
  /** `.inParallel([…branches])` (#1279): branches of any kind launched at once. */
  InParallel = "in-parallel",
  /** `.forEachItem(step, { maxItems | takeFirst })` (#1280): one run of `step` per item of the list before it. */
  ForEachItem = "for-each-item",
}

/** An error class: what `.onError(…)` catches (by class, through the cause chain) and `toFailWith` matches. */
export type ErrorClass<TError extends Error = Error> = abstract new (...args: never[]) => TError;

/** A path's first node: a start, or the shared node whose own path it is. */
export type PathSource = StartSource | ComponentSource;

export interface StartSource {
  readonly kind: NodeKind.Start;
  readonly node: Class;
}

export interface ComponentSource {
  readonly kind:
    NodeKind.Agent | NodeKind.Action | NodeKind.Router | NodeKind.Workflow | NodeKind.Question;
  readonly node: Class;
}

/**
 * `.toAgent` / `.toRouter` / `.toAction` / `.toFinish` / `.toWorkflow` (#263) / `.toQuestion` (#659):
 * the kind is the transition's.
 */
export interface ToStep {
  readonly kind: StepKind.To;
  readonly target: Class;
  readonly targetKind: NodeKind;
  /** `.toExternalTask(Q, { expiresIn })` (#941): the question's deadline; absent = its role's. */
  readonly expiresIn?: Milliseconds | WorkingDuration;
  /** `.onError(E, skip())` (#1279): written on a branch of `.inParallel([…])` / `.forEachItem(…)` only. */
  readonly skip?: readonly ErrorClass[];
  /** `toRouter(R).chooseMany([…])` (#1279b): the branches the router picks among; a branch of `.inParallel([…])` only. */
  readonly chooses?: readonly ParallelBranchStep[];
}

/** One `caseOf(XDto)…` of a `.switch(…)`. */
export interface SwitchCase {
  readonly dto: DtoClass;
  readonly path: SubPath;
}

export interface SwitchStep {
  readonly kind: StepKind.Switch;
  readonly cases: readonly SwitchCase[];
}

/**
 * `.toOneOf([toAction(A)…, toFinish(F)])` (#1275): one side path per variant of the `oneOf(…)` the
 * step before gives. A branch names no DTO — its variant is the one its entry consumer reads
 * (`analyse/one-of.ts`).
 */
export interface OneOfStep {
  readonly kind: StepKind.OneOf;
  readonly branches: readonly SubPath[];
}

/**
 * `.onFinish(KycFraudFinish, toAction(X)…)` (#1275b): the path the child workflow's finish takes. It
 * names the finish by its component class, never by the DTO it outputs: two finishes may output one.
 */
export interface OnFinishStep {
  readonly kind: StepKind.OnFinish;
  readonly finish: Class;
  readonly path: SubPath;
}

/** One `route(X)…` of a `.chooseOne(…)`: its target and what follows it. */
export interface ChooseOneRoute {
  readonly target: Class;
  readonly path: SubPath;
}

export interface ChooseOneStep {
  readonly kind: StepKind.ChooseOne;
  readonly routes: readonly ChooseOneRoute[];
}

/** `.onError(ErrorClass, toAction(X)…)`: the side path the step's failure takes. */
export interface OnErrorStep {
  readonly kind: StepKind.OnError;
  readonly error: ErrorClass;
  readonly path: SubPath;
}

/** An `@Arbiter` class (#279): decides whether an answer of a launch counts. */
export type ArbiterClass = Class;

/** What a launch runs (#273): agents, actions, or a child workflow per item (#263). */
export type LaunchTargetKind = NodeKind.Agent | NodeKind.Action | NodeKind.Workflow;

/**
 * `.toParallelAgents(A, B, …, { maxConcurrency, maxItems })` (#273): each listed target runs once
 * (repeats are copies); with one target right after a step whose output is a list it runs once per
 * item of that list. `.toParallelWorkflows(W, { maxConcurrency, maxItems })` (#263) runs one
 * child workflow per item — always per item, one target.
 */
export interface LaunchStep {
  readonly kind: StepKind.Launch;
  readonly targetKind: LaunchTargetKind;
  /** As listed, repeats included. */
  readonly targets: readonly Class[];
  /** At most this many branches in progress at once; a limit only. */
  readonly maxConcurrency?: number;
  /** A per-item launch takes the first `maxItems` items (`[launch.max-items-required]`). */
  readonly maxItems?: number;
  /**
   * `.arbitratedBy(A)` after it (#279, #1282): the one arbiter every branch's answer passes before a
   * quorum counts it — it runs inside the branch. Agents only, before a quorum join.
   */
  readonly arbitratedBy?: ArbiterClass;
}

/** What a branch of `.inParallel([…])` / `.forEachItem(…)` runs (#1279): any component a path enters. */
export type ParallelTargetKind =
  NodeKind.Agent | NodeKind.Action | NodeKind.Workflow | NodeKind.Question | NodeKind.Router;

/**
 * One branch of `.inParallel([…])` / the step of `.forEachItem(…)` (#1279, #1280): its target and
 * kind, and the error classes `.onError(E, skip())` drops out of the join (#1279) — a failed branch
 * of such a class leaves its place empty instead of failing the launch. A thunk-named child workflow
 * (#1287) is read on first use, like a `ToStep` target.
 */
export interface ParallelBranchStep {
  readonly target: Class;
  readonly targetKind: ParallelTargetKind;
  /** `.onError(E, skip())`: the classes whose failure the branch drops; empty = a failure fails the launch. */
  readonly skip: readonly ErrorClass[];
  /**
   * A router branch, `toRouter(R).chooseMany([…])` (#1279b): `target` is the router, these are the
   * branches it picks among — none, some or all of them run. Never nested.
   */
  readonly chooses?: readonly ParallelBranchStep[];
}

/**
 * `.inParallel([toAgent(A), toAction(X).onError(StepError, skip()), …], { maxConcurrency })`
 * (#1279): each listed branch runs once, of any kind; always followed by `.join()`.
 */
export interface InParallelStep {
  readonly kind: StepKind.InParallel;
  /** As listed, repeats included. */
  readonly branches: readonly ParallelBranchStep[];
  /** At most this many branches in progress at once; a limit only. */
  readonly maxConcurrency?: number;
  /** `.arbitratedBy(A)` after it (#1282): the one arbiter every branch's answer passes before a quorum counts it. */
  readonly arbitratedBy?: ArbiterClass;
}

/**
 * `.forEachItem(toAgent(A), { maxItems | takeFirst, maxConcurrency })` (#1280): one run of the step
 * per item of the list the step before gives — the first `takeFirst` items, or all of them when there
 * are at most `maxItems` (more throws `LimitError.Items` before any branch starts).
 */
export interface ForEachItemStep {
  readonly kind: StepKind.ForEachItem;
  readonly branch: ParallelBranchStep;
  /** A strict upper bound: more items throw `LimitError.Items`, handled by `.onError(…)` after the join. */
  readonly maxItems?: number;
  /** An intended slice: the first `takeFirst` items run, the rest are dropped, recorded. */
  readonly takeFirst?: number;
  readonly maxConcurrency?: number;
  /** `.arbitratedBy(A)` after it (#1282): the one arbiter every item's answer passes before a quorum counts it. */
  readonly arbitratedBy?: ArbiterClass;
}

/** `.onError(ErrorClass, toAction(X)…)`: the side path a failed launch takes. */
export interface JoinErrorHandler {
  readonly error: ErrorClass;
  readonly path: SubPath;
}

/** How a quorum join decides (#279). */
export enum QuorumKind {
  /** `.joinQuorum({ min, max, deadline })`: enough counted answers. */
  Count = "count",
  /** `.joinQuorumGroups({ deadline })` + `.onGroup(…)`: the first (highest-priority) group complete. */
  Groups = "groups",
}

/** `.joinQuorum({ min, max, deadline })`, as written: `max` defaults to `min`. */
export interface CountQuorum {
  readonly kind: QuorumKind.Count;
  /** How many counted answers are enough to go on. */
  readonly min: number;
  /** After how many counted answers the rest is cancelled; `min` when absent. */
  readonly max?: number;
  /** How long the join waits: `seconds()`, `minutes()`, `hours()`, or working time (`workDays()`) counted by `calendar`. */
  readonly deadline?: Milliseconds | WorkingDuration;
  /** The `@WorkingCalendar` class that counts a working-time `deadline` (#1306); required with one. */
  readonly calendar?: Class;
}

/**
 * One `.onGroup([A, B], { priority }, subPath)` of `.joinQuorumGroups({ deadline })` (#1284): the
 * targets of the launch whose counted answers complete it (a repeat is one more copy), its priority
 * (1 is the highest; none — equal) and the path it continues with.
 */
export interface QuorumGroup {
  /** As listed, repeats included. */
  readonly targets: readonly Class[];
  readonly priority?: number;
  /** The group's own path. */
  readonly path: SubPath;
}

/** `.joinQuorumGroups({ deadline })` and its `.onGroup(…)`s: each group continues its own path. */
export interface GroupsQuorum {
  readonly kind: QuorumKind.Groups;
  readonly groups: readonly QuorumGroup[];
  /** As `CountQuorum.deadline`: plain or working time. */
  readonly deadline?: Milliseconds | WorkingDuration;
  /** The `@WorkingCalendar` class that counts a working-time `deadline` (#1306). */
  readonly calendar?: Class;
}

export type Quorum = CountQuorum | GroupsQuorum;

/**
 * `.join()` (#273): waits for every branch; what the branches give is derived from them. A quorum
 * join (#279) counts the accepted answers instead; `.joinQuorumGroups(…)`'s groups each continue
 * their own path.
 */
export interface JoinStep {
  readonly kind: StepKind.Join;
  readonly onError: readonly JoinErrorHandler[];
  /** `.joinQuorum(…)` / `.joinQuorumGroups(…)`; absent for `.join()`. */
  readonly quorum?: Quorum;
}

export type Step =
  | ToStep
  | SwitchStep
  | OneOfStep
  | OnFinishStep
  | ChooseOneStep
  | OnErrorStep
  | LaunchStep
  | InParallelStep
  | ForEachItemStep
  | JoinStep;

/** The steps inside `route(X)…`, `caseOf(D)…`, a `.toOneOf([…])` branch or the side path of `.onError`. */
export interface SubPath {
  readonly steps: readonly Step[];
}

/** One entry of `@Workflow({ flow })`: a source and its steps, in order. */
export interface FlowPath {
  readonly source: PathSource;
  readonly steps: readonly Step[];
}
