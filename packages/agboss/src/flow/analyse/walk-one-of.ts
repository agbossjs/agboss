import type { OneOfStep, Step } from "../ast.js";
import type { ComponentName } from "../registry.js";
import { EdgeKind, outputOf, valueWrite } from "./flow-graph.js";
import type { NodeTable } from "./nodes.js";
import { resolveOneOf } from "./one-of.js";
import { variantsOf } from "./rules/switch.js";
import type { Cursor } from "./walk-cursor.js";
import type { OneOfSite } from "./walked-flow.js";

/** One branch of a `.toOneOf([…])` and where its walk starts: the variant it reads is written. */
export interface OneOfBranchWalk {
  readonly steps: readonly Step[];
  readonly cursor: Cursor;
}

/** The variants of the `.toOneOf([…])` after `current`, and each branch's walk (#1275). */
export function planOneOf(
  table: NodeTable,
  step: OneOfStep,
  cursor: Cursor,
  current: ComponentName,
): { readonly site: OneOfSite; readonly branches: readonly OneOfBranchWalk[] } {
  const resolution = resolveOneOf(variantsOf(outputOf(table.node(current))), step);
  const branches = step.branches.map((branch, index): OneOfBranchWalk => {
    const variant = resolution.variants[index];
    const inner: Cursor = {
      current,
      writes: variant === undefined ? [] : [valueWrite(variant, true)],
      entry: EdgeKind.Case,
      path: cursor.path,
      depth: cursor.depth + 1,
    };
    return { steps: branch.steps, cursor: inner };
  });
  return { site: { node: current, step, resolution }, branches };
}
