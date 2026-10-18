import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import {
  NodeKind,
  StepKind,
  type ChooseOneRoute,
  type ComponentSource,
  type ErrorClass,
  type JoinStep,
  type LaunchTargetKind,
  type PathSource,
  type ReturnedValue,
  type Step,
  type SubPath,
  type SwitchCase,
} from "./ast.js";
import type { ReturnsOptions } from "./builder-types.js";
import { isReturnedShape, Wrapper } from "./dto-wrappers.js";
import { FlowSyntaxError, launchOrderProblem, launchStepOf } from "./launch-step.js";

/**
 * The runtime of the path builder (#272): one immutable class behind every typed builder state;
 * `builder.ts` gives it its typed entry points. Every call returns a new builder.
 */

export { FlowSyntaxError } from "./launch-step.js";

/** How a builder's path begins: a source, a route, a case, or the side path of `.onError`. */
export type PathStart =
  | { readonly kind: "source" }
  | { readonly kind: "route"; readonly target: Class }
  | { readonly kind: "case"; readonly dto: DtoClass; readonly about?: readonly DtoClass[] }
  | { readonly kind: "side" };

/** `{ about: PlanDto }` or `{ about: [PlanDto, BudgetDto] }` as a list; undefined without one. */
export function aboutTargets(options: ReturnsOptions | undefined): readonly DtoClass[] | undefined {
  const about = options?.about;
  if (about === undefined) return undefined;
  const given: unknown = about;
  const targets: readonly unknown[] = Array.isArray(given) ? given : [given];
  if (targets.length === 0 || targets.some((target) => typeof target !== "function"))
    throw new FlowSyntaxError("{ about } names one DTO class or a non-empty list of them");
  return Object.freeze([...(targets as readonly DtoClass[])]);
}

/** The value of `.returns(value, options?)` (#299, S54): one shape, `{ about }` beside it. */
function returnedValue(shape: unknown, options: unknown, extra: number): ReturnedValue {
  if (!isReturnedShape(shape))
    throw new FlowSyntaxError(".returns(…) takes a DTO class, optional(…), listOf(…) or oneOf(…)");
  if (extra > 0 || (options !== undefined && (typeof options !== "object" || options === null)))
    throw new FlowSyntaxError(
      ".returns(…) takes one value — chain .returns(A).returns(optional(B)) for several",
    );
  const about = aboutTargets(options);
  if (about === undefined) return Object.freeze({ shape });
  if (typeof shape !== "function" && shape.kind === Wrapper.OneOf)
    throw new FlowSyntaxError(
      "{ about } does not go on .returns(oneOf(…)) — write it on the case: caseOf(XDto, { about })",
    );
  return Object.freeze({ shape, about });
}

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
    return new PathBuilder(this.start, this.source, [...this.steps.slice(0, -1), Object.freeze(join)]);
  }

  private to(target: Class, targetKind: NodeKind): PathBuilder<TSource> {
    return this.then({ kind: StepKind.To, target, targetKind });
  }

  returns(shape: unknown, options?: unknown, ...rest: readonly unknown[]): PathBuilder<TSource> {
    const value = returnedValue(shape, options, rest.length);
    const { last } = this;
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

  join(): PathBuilder<TSource> {
    return this.then({ kind: StepKind.Join, returns: Object.freeze([]), onJoinError: Object.freeze([]) });
  }

  onJoinError(error: ErrorClass, path: PathBuilder): PathBuilder<TSource> {
    const { last } = this;
    if (last?.kind !== StepKind.Join || last.returns.length > 0)
      throw new FlowSyntaxError(".onJoinError(E, …) stands right after .join(), before its .returns(…)");
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
    return Object.freeze({ target: this.start.target, path: this.subPath() });
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
