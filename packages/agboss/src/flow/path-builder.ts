import type { Class } from "../components/injection.js";
import {
  NodeKind,
  StepKind,
  type ChooseOneRoute,
  type ErrorClass,
  type LaunchTargetKind,
  QuorumKind,
  type PathSource,
  type Quorum,
  type Step,
  type SubPath,
  type SwitchCase,
  type ToStep,
} from "./ast.js";
import { caseOfPath, oneOfStepOf, onFinishStepOf, routeOf, routeOfPath } from "./branch-step.js";
import * as parallel from "./parallel-step.js";
import { FlowSyntaxError, launchOrderProblem, launchStepOf, siteOf } from "./launch-step.js";
import {
  arbitratedByOf,
  arbitratingLaunch,
  countQuorumOf,
  groupsJoinOf,
  groupsQuorumOf,
  quorumGroupOf,
  withGroup,
} from "./quorum-step.js";
import { expiresInOptionOf } from "./question-options.js";
import type { PathStart } from "./path-start.js";
import { withTarget, type TargetRef } from "./target-ref.js";
import { carryStepSpan, recordStepSpan } from "./step-spans.js";

/**
 * The runtime of the path builder (#272): one immutable class behind every typed builder state;
 * `builder.ts` gives it its typed entry points. Every call returns a new builder.
 */

export { FlowSyntaxError } from "./launch-step.js";
export { fromComponent } from "./path-sources.js";

const syntaxError = (message: string): FlowSyntaxError => new FlowSyntaxError({ message });

export type { PathStart } from "./path-start.js";

const SIDE_PATH_HINT = "toAction(…), toAgent(…), toFinish(…), …";

/** A flow path's builder holds its source; a sub-path's holds `undefined`. */
type SourceOf = PathSource | undefined;

export class PathBuilder<TSource extends SourceOf = SourceOf> {
  constructor(
    private readonly start: PathStart,
    readonly source: TSource,
    readonly steps: readonly Step[],
  ) {
    Object.freeze(this.steps);
  }

  private get last(): Step | undefined {
    return this.steps[this.steps.length - 1];
  }

  private then(step: Step): PathBuilder<TSource> {
    const problem = launchOrderProblem(this.last, step);
    if (problem !== undefined) throw syntaxError(problem);
    return new PathBuilder(this.start, this.source, [...this.steps, recordStepSpan(step)]);
  }

  /** The last step replaced: a join extended, a launch given its arbiter. */
  private withLast(step: Step): PathBuilder<TSource> {
    const replaced = this.last;
    const kept = replaced === undefined ? step : carryStepSpan(replaced, step);
    return new PathBuilder(this.start, this.source, [...this.steps.slice(0, -1), kept]);
  }

  private to(
    target: TargetRef,
    kind: NodeKind,
    extra: Pick<ToStep, "expiresIn"> = {},
  ): PathBuilder<TSource> {
    const rest = { kind: StepKind.To as const, targetKind: kind, ...extra };
    // only a child workflow may be named by a thunk (#1287): any other target is read as written
    const step: ToStep =
      kind === NodeKind.Workflow
        ? withTarget("target", target, rest)
        : { ...rest, target: target as Class };
    return this.then(step);
  }

  toAgent(target: Class): PathBuilder<TSource> {
    return this.to(target, NodeKind.Agent);
  }

  toRouter(target: Class): PathBuilder<TSource> {
    return this.to(target, NodeKind.Router);
  }

  toAction(target: Class): PathBuilder<TSource> {
    return this.to(target, NodeKind.Action);
  }

  toFinish(target: Class): PathBuilder<TSource> {
    return this.to(target, NodeKind.Finish);
  }

  /** `.toExternalTask(Role)` (#659): the question role's step — it pauses, its answer goes on the path. */
  toExternalTask(target: Class, options?: unknown): PathBuilder<TSource> {
    return this.to(target, NodeKind.Question, expiresInOptionOf(options, "toExternalTask(Q, {…})"));
  }

  /** `.toWorkflow(W)` (#263): one child of `W`; where it runs is `W`'s `placement` (#1286). */
  toWorkflow(target: TargetRef): PathBuilder<TSource> {
    return this.to(target, NodeKind.Workflow);
  }

  switch(...cases: readonly PathBuilder[]): PathBuilder<TSource> {
    return this.then({ kind: StepKind.Switch, cases: cases.map((path) => path.asCase()) });
  }

  /** `.toOneOf([toAction(A)…, toFinish(F)])` (#1275): the branches of a `oneOf(…)` output. */
  toOneOf(branches: unknown): PathBuilder<TSource> {
    return this.then(oneOfStepOf(branches, (path, call) => PathBuilder.sideOf(path, call)));
  }

  /** `.onFinish(KycFraudFinish, toAction(X)…)` (#1275b): the side path one finish of a child takes. */
  onFinish(finish: unknown, path: unknown): PathBuilder<TSource> {
    return this.then(onFinishStepOf(finish, path, (side, call) => PathBuilder.sideOf(side, call)));
  }

  chooseOne(...routes: readonly PathBuilder[]): PathBuilder<TSource> {
    return this.then({ kind: StepKind.ChooseOne, routes: routes.map((path) => path.asRoute()) });
  }

  /**
   * `.onRoute(toAgent(A)…)` (#1278): one route of the router before it — the starter names the
   * target, the rest of the chain is what follows it. Consecutive calls are one choice.
   */
  onRoute(path: unknown): PathBuilder<TSource> {
    const route = routeOf(path, (side, call) => PathBuilder.sideOf(side, call));
    const { last } = this;
    if (last?.kind !== StepKind.ChooseOne)
      return this.then({ kind: StepKind.ChooseOne, routes: Object.freeze([route]) });
    return this.withLast(
      Object.freeze({ ...last, routes: Object.freeze([...last.routes, route]) }),
    );
  }

  /**
   * `.onError(E, side path)`: after a step it handles that step's failure; right after a join
   * (`.join()`, `.joinQuorum(…)`, `.joinQuorumGroups(…)`) it handles the join's failure (#1281) — after
   * `.joinQuorumGroups(…)` only before its first `.onGroup(…)` (#1284).
   */
  onError(error: ErrorClass, path: PathBuilder | parallel.Skip): PathBuilder<TSource> {
    if (parallel.isSkip(path)) return this.withLast(parallel.skippedStepOf(this.at, error));
    const { last } = this;
    if (last?.kind !== StepKind.Join)
      return this.then({ kind: StepKind.OnError, error, path: path.asSidePath() });
    if (last.quorum?.kind === QuorumKind.Groups && last.quorum.groups.length > 0)
      throw syntaxError(
        ".onError(E, …) stands right after .joinQuorumGroups(…), before its first .onGroup(…) — not after one",
      );
    const handler = Object.freeze({ error, path: path.asSidePath() });
    return this.withLast(
      Object.freeze({ ...last, onError: Object.freeze([...last.onError, handler]) }),
    );
  }

  /** Where this builder stands for `skip()` and `chooseMany`: its last step, and whether it is a side path. */
  private get at(): parallel.BranchSite {
    return { last: this.last, isSubPath: parallel.isSidePath(this.source, this.start) };
  }

  /** `toRouter(R).chooseMany([toAgent(A), …])` (#1279b): a router branch of `.inParallel([…])`. */
  chooseMany(branches: unknown): PathBuilder<TSource> {
    return this.withLast(parallel.chosenStepOf(this.at, branches, PathBuilder.branchOf));
  }

  /** `.inParallel([toAgent(A), toAction(X).onError(E, skip()), …], { maxConcurrency })` (#1279). */
  inParallel(branches: unknown, options?: unknown): PathBuilder<TSource> {
    return this.then(parallel.inParallelStepOf(branches, options, PathBuilder.branchOf));
  }

  /** `.forEachItem(toAgent(A), { maxItems | takeFirst, maxConcurrency })` (#1280). */
  forEachItem(step: unknown, options?: unknown): PathBuilder<TSource> {
    return this.then(parallel.forEachItemStepOf(step, options, PathBuilder.branchOf));
  }

  toParallelAgents(...args: readonly unknown[]): PathBuilder<TSource> {
    return this.launch(NodeKind.Agent, args);
  }

  toParallelActions(...args: readonly unknown[]): PathBuilder<TSource> {
    return this.launch(NodeKind.Action, args);
  }

  /** `.toParallelWorkflows(W, { maxConcurrency, maxItems })` (#263): one child per item of the list. */
  toParallelWorkflows(...args: readonly unknown[]): PathBuilder<TSource> {
    return this.launch(NodeKind.Workflow, args);
  }

  /** A join step, with the quorum of `.joinQuorum(…)` / `.joinQuorumGroups(…)` when it has one. */
  private joined(quorum?: Quorum): PathBuilder<TSource> {
    return this.then({
      kind: StepKind.Join,
      onError: Object.freeze([]),
      ...(quorum && { quorum }),
    });
  }

  join(): PathBuilder<TSource> {
    return this.joined();
  }

  /** `.arbitratedBy(A)` (#1282): the one arbiter every answer of the launch passes before a quorum counts it. */
  arbitratedBy(arbiter: unknown): PathBuilder<TSource> {
    const launch = arbitratingLaunch(this.last);
    return this.withLast(Object.freeze({ ...launch, arbitratedBy: arbitratedByOf(arbiter) }));
  }

  /** `.joinQuorum({ min, max, deadline })` (#279): goes on with the counted answers. */
  joinQuorum(options: unknown): PathBuilder<TSource> {
    return this.joined(countQuorumOf(options));
  }

  /** `.joinQuorumGroups({ deadline })` (#1284): its groups follow as `.onGroup([…], options?, subPath)`. */
  joinQuorumGroups(options?: unknown): PathBuilder<TSource> {
    return this.joined(groupsQuorumOf(options));
  }

  /**
   * `.onGroup([A, B], { priority }, subPath)` (#1284): the group of the launch's targets whose counted
   * answers complete it, and the path it continues with; `{ priority }` is optional (1 is the highest).
   */
  onGroup(targets: unknown, ...rest: readonly unknown[]): PathBuilder<TSource> {
    const join = groupsJoinOf(this.last, rest.length);
    const path = PathBuilder.sideOf(rest[rest.length - 1], ".onGroup(…)");
    const group = quorumGroupOf(targets, rest.length === 2 ? rest[0] : undefined, path);
    return this.withLast(withGroup(join, group));
  }

  private launch(targetKind: LaunchTargetKind, args: readonly unknown[]): PathBuilder<TSource> {
    return this.then(launchStepOf(targetKind, args, siteOf(this.last, this.source)));
  }

  private subPath(): SubPath {
    return Object.freeze({ steps: this.steps });
  }

  private asCase(): SwitchCase {
    return caseOfPath(this.start, this.subPath());
  }

  private asRoute(): ChooseOneRoute {
    return routeOfPath(this.start, this.subPath());
  }

  /** A side path of `call` (`.toOneOf([…])`, `.onFinish(F, …)`), or a syntax error. */
  static sideOf(path: unknown, call: string, isBranch = false): SubPath {
    if (path instanceof PathBuilder) return path.asSidePath(`${call} takes side paths`, isBranch);
    throw syntaxError(`${call} takes side paths: ${SIDE_PATH_HINT}`);
  }

  /** A branch of `.inParallel([…])` / `.forEachItem(…)`: a side path that may carry a `skip()`. */
  private static readonly branchOf = (path: unknown, call: string): SubPath =>
    PathBuilder.sideOf(path, call, true);

  private asSidePath(call = ".onError(E, …) takes a side path", isBranch = false): SubPath {
    if (this.start.kind !== "side" || (!isBranch && this.steps.some(parallel.isBranchOnly)))
      throw syntaxError(`${call}: ${SIDE_PATH_HINT}`);
    return this.subPath();
  }
}

export const fromSource = (source: PathSource): PathBuilder<PathSource> =>
  new PathBuilder({ kind: "source" }, Object.freeze(source), []);

/** A sub-path's builder. */
export const subPathFrom = (start: PathStart): PathBuilder<undefined> =>
  new PathBuilder(start, undefined, []);
