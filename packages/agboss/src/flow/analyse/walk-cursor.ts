import { NodeKind, type ErrorClass, type PathSource, type ToStep } from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import { derivedWrites } from "./derived-writes.js";
import type { NodeTable } from "./nodes.js";
import type { ComponentName } from "../registry.js";
import type { JoinGroup } from "./join-groups.js";
import { EdgeKind, type FlowLaunch, type JoinEdge, type ValueWrite } from "./flow-graph.js";

/** Where a walk stands: the node the next step follows, and what the edge to the next node carries. */
export interface Cursor {
  readonly current: ComponentName | undefined;
  /** What the step `current` gives, derived from its declaration (#1270). */
  readonly writes: readonly ValueWrite[];
  readonly entry: EdgeKind;
  readonly error?: ErrorClass;
  /** A branch of a `.toOneOf` or `.onFinish`: what picks it (`FlowEdge.caseKey`). */
  readonly caseKey?: string;
  readonly depth: number;
  readonly path: PathSource;
  /** A launch waiting for its join, then a join waiting for its `.to…(…)` (#273). */
  readonly launch?: FlowLaunch;
  readonly join?: JoinEdge;
  /** A `.onError(…)` side path's first edge (#945): what the launch's branches give. */
  readonly settled?: readonly JoinGroup[];
}

/** Where a walk stands after a node is entered. */
export const nextCursor = (
  current: ComponentName | undefined,
  depth: number,
  path: PathSource,
  writes: readonly ValueWrite[] = [],
): Cursor => ({
  current,
  writes,
  entry: EdgeKind.Next,
  depth,
  path,
});

/** Where a walk stands at `node`: what the step gives, derived from its declaration (#1270). */
export const cursorAt = (
  table: NodeTable,
  node: ComponentName | undefined,
  depth: number,
  path: PathSource,
): Cursor =>
  nextCursor(node, depth, path, node === undefined ? [] : derivedWrites(table.node(node)));

/** A route target's kind is the kind its class is declared with (the builder checked it). */
export const kindOfTarget = (target: ToStep["target"]): NodeKind =>
  declarationOf(target)?.kind ?? NodeKind.Agent;
