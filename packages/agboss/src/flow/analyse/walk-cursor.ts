import type { ErrorClass, PathSource } from "../ast.js";
import type { OneOfWrapper } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import { EdgeKind, type FlowLaunch, type JoinEdge, type ValueWrite } from "./flow-graph.js";

/** Where a walk stands: the node the next step follows, and what the edge to the next node carries. */
export interface Cursor {
  readonly current: ComponentName | undefined;
  readonly writes: readonly ValueWrite[];
  /** A `.returns(oneOf(…))` the next `.switch(…)` branches (#299 S54 c). */
  readonly oneOf?: OneOfWrapper;
  readonly entry: EdgeKind;
  readonly error?: ErrorClass;
  readonly depth: number;
  readonly path: PathSource;
  /** A launch waiting for its join, then a join waiting for its `.to…(…)` (#273). */
  readonly launch?: FlowLaunch;
  readonly join?: JoinEdge;
}

/** Where a walk stands after a node is entered: nothing returned yet. */
export const nextCursor = (
  current: ComponentName | undefined,
  depth: number,
  path: PathSource,
): Cursor => ({
  current,
  writes: [],
  entry: EdgeKind.Next,
  depth,
  path,
});
