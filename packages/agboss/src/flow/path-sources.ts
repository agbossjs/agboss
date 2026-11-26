import { ComponentKind } from "./runtime/records.js";
import type { Class } from "../components/injection.js";
import type { ComponentSource, PathSource } from "./ast.js";
import { fromSource, type PathBuilder } from "./path-builder.js";
import { withTarget, type TargetRef } from "./target-ref.js";

/** The builder `onAgent(X)…` starts: a component's own path. */

export const fromComponent = (
  kind: ComponentSource["kind"],
  node: TargetRef,
): PathBuilder<PathSource> =>
  // a child workflow may be named by a thunk (#1287), read when the path is analysed
  fromSource(
    kind === ComponentKind.Workflow
      ? withTarget("node", node, { kind })
      : { kind, node: node as Class },
  );
