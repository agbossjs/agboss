import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type ChooseOneRoute,
  type ComponentSource,
  type ErrorClass,
  type JoinStep,
  type LaunchTargetKind,
  type PathSource,
  type QuorumGroup,
  type Step,
  type SubPath,
  type SwitchCase,
  type ToStep,
} from "./ast.js";
import { FlowSyntaxError, launchOrderProblem, launchStepOf } from "./launch-step.js";
import {
  acceptedByOf,
  acceptingLaunch,
  countQuorumOf,
  groupsQuorumOf,
  priorityOf,
  quorumGroupOf,
  type GroupStart,
} from "./quorum-step.js";
import { returnedValue } from "./returns-step.js";
import { placementOptionOf, type ChildPlacement } from "./child-placement.js";

/**
 * The runtime of the path builder (#272): one immutable class behind every typed builder state;
 * `builder.ts` gives it its typed entry points. Every call returns a new builder.
 */

export { FlowSyntaxError } from "./launch-step.js";
export { aboutTargets } from "./returns-step.js";

/** How a builder's path begins: a source, a route, a case, or the side path of `.onError`. */
export type PathStart =
  | { readonly kind: "source" }
  | { readonly kind: "route"; readonly target: Class; readonly placement?: ChildPlacement }
  | { readonly kind: "case"; readonly dto: DtoClass; readonly about?: readonly DtoClass[] }
  | { readonly kind: "side" }
  | GroupStart;

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
    if (problem !== undefined) throw new FlowSyntaxError(problem);
    return new PathBuilder(this.start, this.source, [...this.steps, step]);
  }

  /** The join with a new handler or value: `.onJoinError(…)` and `.returns(…)` extend it. */
  private withJoin(join: JoinStep): PathBuilder<TSource> {
    return this.withLast(Object.freeze(join));
  }

  /** The last step replaced: a join extended, a launch given one more arbiter. */
  private withLast(step: Step): PathBuilder<TSource> {
    return new PathBuilder(this.start, this.source, [...this.steps.slice(0, -1), step]);
  }

  private to(target: Class, kind: NodeKind, placement?: ChildPlacement): PathBuilder<TSource> {
    const step: ToStep = { kind: StepKind.To, target, targetKind: kind };
    return this.then(placement === undefined ? step : { ...step, placement });
  }

  returns(shape: unknown, options?: unknown, ...rest: readonly unknown[]): PathBuilder<TSource> {
    const value = returnedValue(shape, options, rest.length);
    const { last } = this;
    if (last?.kind === StepKind.Join && last.quorum?.kind === QuorumKind.Groups)
      throw new FlowSyntaxError(
        "each group names its values: group(…).returns(…) — not after .joinQuorumGroups(…)",
      );
    if (last?.kind === StepKind.Join)
      return this.withJoin({ ...last, returns: Object.freeze([...last.returns, value]) });
    return this.then({ kind: StepKind.Returns, value });
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

  /** `.toWorkflow(W)` (#263): one child of `W`; `.toWorkflow(W, { placement })` (#333 PR 2). */
  toWorkflow(target: Class, options?: unknown): PathBuilder<TSource> {
    return this.to(target, NodeKind.Workflow, placementOptionOf(options, "toWorkflow(W, {…})"));
  }

  switch(...cases: readonly PathBuilder[]): PathBuilder<TSource> {
    return this.then({ kind: StepKind.Switch, cases: cases.map((path) => path.asCase()) });
  }

  chooseOne(...routes: readonly PathBuilder[]): PathBuilder<TSource> {
    return this.then({ kind: StepKind.ChooseOne, routes: routes.map((path) => path.asRoute()) });
  }

  onError(error: ErrorClass, path: PathBuilder): PathBuilder<TSource> {
    return this.then({ kind: StepKind.OnError, error, path: path.asSidePath() });
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

  join(): PathBuilder<TSource> {
    return this.then({
      kind: StepKind.Join,
      returns: Object.freeze([]),
      onJoinError: Object.freeze([]),
    });
  }

  /** `.acceptedBy(A)` / `.acceptedBy(anyOf(A, B))` (#279): one more arbiter of the launch, AND. */
  acceptedBy(choice: unknown): PathBuilder<TSource> {
    const launch = acceptingLaunch(this.last);
    const acceptedBy = Object.freeze([...(launch.acceptedBy ?? []), acceptedByOf(choice)]);
    return this.withLast(Object.freeze({ ...launch, acceptedBy }));
  }

  /** `.joinQuorum({ min, max, deadline })` (#279): goes on with the counted answers. */
  joinQuorum(options: unknown): PathBuilder<TSource> {
    return this.then({
      kind: StepKind.Join,
      returns: Object.freeze([]),
      onJoinError: Object.freeze([]),
      quorum: countQuorumOf(options),
    });
  }

  /** `.joinQuorumGroups(group(…)…, { deadline })` (#279): each group continues its own path. */
  joinQuorumGroups(...args: readonly unknown[]): PathBuilder<TSource> {
    const asGroup = (path: unknown): QuorumGroup | undefined =>
      path instanceof PathBuilder ? path.asGroup() : undefined;
    return this.then({
      kind: StepKind.Join,
      returns: Object.freeze([]),
      onJoinError: Object.freeze([]),
      quorum: groupsQuorumOf(args, asGroup),
    });
  }

  /** `group(…).priority(n)`: 1 is the highest; written right after `group(…)`. */
  priority(priority: unknown): PathBuilder<TSource> {
    if (this.start.kind !== "group" || this.steps.length > 0)
      throw new FlowSyntaxError(".priority(n) stands right after group(…)");
    const start = { ...this.start, priority: priorityOf(priority) };
    return new PathBuilder(start, this.source, this.steps);
  }

  onJoinError(error: ErrorClass, path: PathBuilder): PathBuilder<TSource> {
    const { last } = this;
    if (last?.kind !== StepKind.Join || last.returns.length > 0)
      throw new FlowSyntaxError(
        ".onJoinError(E, …) stands right after .join(), before its .returns(…)",
      );
    const handler = Object.freeze({ error, path: path.asSidePath() });
    return this.withJoin({ ...last, onJoinError: Object.freeze([...last.onJoinError, handler]) });
  }

  private launch(targetKind: LaunchTargetKind, args: readonly unknown[]): PathBuilder<TSource> {
    const { last } = this;
    const followsRouter =
      last === undefined
        ? this.source?.kind === NodeKind.Router
        : last.kind === StepKind.To && last.targetKind === NodeKind.Router;
    return this.then(launchStepOf(targetKind, args, { previous: last, followsRouter }));
  }

  private subPath(): SubPath {
    return Object.freeze({ steps: this.steps });
  }

  private asCase(): SwitchCase {
    if (this.start.kind !== "case") throw new FlowSyntaxError(".switch(…) takes caseOf(…) paths");
    const { dto, about } = this.start;
    const path = this.subPath();
    return Object.freeze(about === undefined ? { dto, path } : { dto, about, path });
  }

  private asRoute(): ChooseOneRoute {
    if (this.start.kind !== "route")
      throw new FlowSyntaxError(".chooseOne(…) takes route(…) paths");
    const { target, placement } = this.start;
    return Object.freeze({ target, path: this.subPath(), ...(placement && { placement }) });
  }

  /** A group: its leading `.returns(…)` chain are its values, the rest its own path. */
  private asGroup(): QuorumGroup | undefined {
    return this.start.kind === "group" ? quorumGroupOf(this.start, this.steps) : undefined;
  }

  private asSidePath(): SubPath {
    if (this.start.kind !== "side")
      throw new FlowSyntaxError(".onError(E, …) takes a side path: toAction(…), toFinish(…), …");
    return this.subPath();
  }
}

export const fromSource = (source: PathSource): PathBuilder<PathSource> =>
  new PathBuilder({ kind: "source" }, Object.freeze(source), []);

export const fromComponent = (
  kind: ComponentSource["kind"],
  node: Class,
): PathBuilder<PathSource> => fromSource({ kind, node });

/** A sub-path's builder. */
export const subPathFrom = (start: PathStart): PathBuilder<undefined> =>
  new PathBuilder(start, undefined, []);

/** `group(A, B, …)` of `.joinQuorumGroups(…)` (#279): one or more agent classes, repeats counted. */
export function groupFrom(agents: readonly unknown[]): PathBuilder<undefined> {
  if (agents.length === 0 || agents.some((agent) => typeof agent !== "function"))
    throw new FlowSyntaxError("group(…) takes one or more agent classes of the launch");
  return subPathFrom({ kind: "group", agents: Object.freeze([...(agents as readonly Class[])]) });
}
