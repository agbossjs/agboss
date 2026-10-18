import type { Class } from "../../../src/components/injection.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { NodeKind, type PathSource } from "../../../src/flow/ast.js";
import type { ReturnsOptions } from "../../../src/flow/builder-types.js";
import type { ValueShape } from "../../../src/flow/dto-wrappers.js";
import {
  aboutTargets,
  fromComponent,
  fromSource,
  groupFrom,
  subPathFrom,
  type PathBuilder,
} from "../../../src/flow/path-builder.js";

/**
 * The path builder without its compile-time checks, for the analyser's tests: the graphs here are
 * wrong on purpose (a shared node inline, a missing case, a wrong kind), which the typed builder
 * (`builder.ts`) would not let compile. The AST it writes is the same.
 */

export const start = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

export const agent = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Agent, source);

export const router = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Router, source);

export const action = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Action, source);

export const workflow = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Workflow, source);

export const route = (target: Class): PathBuilder => subPathFrom({ kind: "route", target });

export const caseOf = (dto: DtoClass, options?: ReturnsOptions): PathBuilder => {
  const about = aboutTargets(options);
  return subPathFrom(about === undefined ? { kind: "case", dto } : { kind: "case", dto, about });
};

/** `.returns(A).returns(B)…` — a start's several values, one `.returns` each (#299 S54). */
export const returnsEach = <TBuilder extends PathBuilder>(
  path: TBuilder,
  shapes: readonly ValueShape[],
): TBuilder => shapes.reduce<TBuilder>((built, shape) => built.returns(shape) as TBuilder, path);

/** A side path of `.onError(E, …)` with nothing in it yet. */
export const side = (): PathBuilder => subPathFrom({ kind: "side" });

export const toAction = (target: Class): PathBuilder =>
  side()
    .toAction(target);

export const toAgent = (target: Class): PathBuilder =>
  side()
    .toAgent(target);

export const toFinish = (target: Class): PathBuilder =>
  side()
    .toFinish(target);

/** `group(A, B, …)` of `.joinQuorumGroups(…)` (#279). */
export const group = (...agents: readonly Class[]): PathBuilder => groupFrom(agents);
