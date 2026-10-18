import type { DtoClass } from "../dto/types.js";
import { NodeKind } from "../flow/ast.js";
import { Wrapper } from "../flow/dto-wrappers.js";
import type { RuntimeNode } from "../flow/runtime/graph-model.js";
import type { OutputClassOf } from "./action-script.js";

/**
 * The class each action of the application returns (for `mockAction(A)` / `toHaveReturned`): its
 * declared `output` — a list's element; a `oneOf` result names its own class with `variant(…)`.
 */
export function actionOutputClassOf(nodes: readonly RuntimeNode[]): OutputClassOf {
  const classes = new Map<string, DtoClass>();
  for (const node of nodes) {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Action) continue;
    const { output } = declaration.options;
    if (typeof output === "function") classes.set(node.id, output);
    else if (output?.kind === Wrapper.List && typeof output.element === "function")
      classes.set(node.id, output.element);
  }
  return (action) => classes.get(action);
}
