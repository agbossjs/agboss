import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";
import type { ChildPlacement } from "./child-placement.js";

/**
 * The graph of a v2 workflow as data (#272 → The AST): `@Workflow({ flow })` holds one `FlowPath`
 * per path. The builder (`builder.ts`) writes it; the analyser (PR 2) and the runtime (PR 4) read it.
 * Parallel launches and their joins (#273) are steps too; a child workflow (#263) is a node of kind
 * `Workflow`, entered by `.toWorkflow(W)` (a `ToStep`) or launched per item by
 * `.toParallelWorkflows(W, …)` (a `LaunchStep`); a quorum (#279) is a join that counts the answers
 * its launch's arbiters accept (`LaunchStep.acceptedBy`, `JoinStep.quorum`).
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
  /** `.toWorkflow(W, { placement })` (#333 PR 2): where the child runs; absent = its parent's instance. */
  readonly placement?: ChildPlacement;
  /** `.toExternalTask(Q, { expiresIn })` (#941): the question's deadline; absent = its role's. */
  readonly expiresIn?: Milliseconds | WorkingDuration;
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
  /** `route(W, { placement })` (#333 PR 2): where a child workflow target runs. */
  readonly placement?: ChildPlacement;
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

/**
 * One `.acceptedBy(…)` of a launch (#279, S57): `.acceptedBy(A)` — one arbiter; `.acceptedBy(anyOf(A,
 * B))` — tried in order, the first that accepts accepts the answer. Several `.acceptedBy(…)` are an
 * AND, in path order.
 */
export interface AcceptedBy {
  readonly arbiters: readonly ArbiterClass[];
}

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
   * `.acceptedBy(…)` after it (#279): the arbiters every branch's answer passes before a quorum
   * counts it — they run inside the branch, in path order. Agents only, before a quorum join.
   */
  readonly acceptedBy?: readonly AcceptedBy[];
  /** `.toParallelWorkflows(W, { placement })` (#333 PR 2): where each child runs. */
  readonly placement?: ChildPlacement;
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
  /** `.joinQuorumGroups(group(…)…, { deadline })`: the first (highest-priority) group complete. */
  Groups = "groups",
}

/** `.joinQuorum({ min, max, deadline })`, as written: `max` defaults to `min`. */
export interface CountQuorum {
  readonly kind: QuorumKind.Count;
  /** How many counted answers are enough to go on. */
  readonly min: number;
  /** After how many counted answers the rest is cancelled; `min` when absent. */
  readonly max?: number;
  /** How long the join waits (`seconds()`, `minutes()`, `hours()`). */
  readonly deadline?: Milliseconds;
}

/**
 * One `group(A, B, …).priority(n).to…(…)` of `.joinQuorumGroups(…)`: the agents whose counted
 * answers complete it (a repeat is one more copy), its priority (1 is the highest; none — equal)
 * and the path it continues with.
 */
export interface QuorumGroup {
  /** As listed, repeats included. */
  readonly agents: readonly Class[];
  readonly priority?: number;
  /** The group's own path. */
  readonly path: SubPath;
}

/** `.joinQuorumGroups(…, { deadline })`: each group continues its own path. */
export interface GroupsQuorum {
  readonly kind: QuorumKind.Groups;
  readonly groups: readonly QuorumGroup[];
  readonly deadline?: Milliseconds;
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
