import type { Class } from "../../../src/components/injection.js";
import { NodeKind, type PathSource } from "../../../src/flow/ast.js";
import type { ValueShape } from "../../../src/flow/dto-wrappers.js";
import {
  fromComponent,
  fromSource,
  subPathFrom,
  type PathBuilder,
} from "../../../src/flow/path-builder.js";

/**
 * The path builder without its compile-time checks, for the analyser's tests: the graphs here are
 * wrong on purpose (a shared node inline, a missing case, a wrong kind), which the typed builder
 * (`builder.ts`) would not let compile. The AST it writes is the same.
 */

export const onStart = (source: Class): PathBuilder<PathSource> =>
  fromSource({ kind: NodeKind.Start, node: source });

export const onAgent = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Agent, source);

export const onRouter = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Router, source);

export const onAction = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Action, source);

export const onWorkflow = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Workflow, source);

export const onExternalTask = (source: Class): PathBuilder<PathSource> =>
  fromComponent(NodeKind.Question, source);

/** A side path of `.onError(E, …)` with nothing in it yet. */
export const side = (): PathBuilder => subPathFrom({ kind: "side" });

export { skip } from "../../../src/flow/parallel-step.js";

export const toAction = (target: Class): PathBuilder =>
  side()
    .toAction(target);

export const toRouter = (target: Class): PathBuilder =>
  side()
    .toRouter(target);

export const toAgent = (target: Class): PathBuilder =>
  side()
    .toAgent(target);

export const toFinish = (target: Class): PathBuilder =>
  side()
    .toFinish(target);

/** The side path `.onError(E, toExternalTask(Q)…)` (#910). */
export const toExternalTask = (target: Class, options?: unknown): PathBuilder =>
  side()
    .toExternalTask(target, options);

/** The side path `.onError(E, toWorkflow(W)…)` (#263 S85). */
export const toWorkflow = (target: Class): PathBuilder =>
  side()
    .toWorkflow(target);
