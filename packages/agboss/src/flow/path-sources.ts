import type { Class } from "../components/injection.js";
import { NodeKind, type ComponentSource, type PathSource } from "./ast.js";
import { FlowSyntaxError } from "./flow-syntax-error.js";
import { fromSource, subPathFrom, type PathBuilder } from "./path-builder.js";
import { withTarget, type TargetRef } from "./target-ref.js";

/** The builders `onAgent(X)…` (a component's own path) and `group(A, B, …)` start. */

export const fromComponent = (
  kind: ComponentSource["kind"],
  node: TargetRef,
): PathBuilder<PathSource> =>
  // a child workflow may be named by a thunk (#1287), read when the path is analysed
  fromSource(
    kind === NodeKind.Workflow ? withTarget("node", node, { kind }) : { kind, node: node as Class },
  );

/** `group(A, B, …)` of `.joinQuorumGroups(…)` (#279): one or more agent classes, repeats counted. */
export function groupFrom(agents: readonly unknown[]): PathBuilder<undefined> {
  if (agents.length === 0 || agents.some((agent) => typeof agent !== "function"))
    throw new FlowSyntaxError({
      message: "group(…) takes one or more agent classes of the launch",
    });
  return subPathFrom({ kind: "group", agents: Object.freeze([...(agents as readonly Class[])]) });
}
