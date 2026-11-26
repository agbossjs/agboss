import { ComponentKind } from "../flow/runtime/records.js";
import { strictMatchOf } from "../dto/schema.js";
import { Wrapper, type OutputShape } from "../flow/dto-wrappers.js";
import type { RuntimeNode } from "../flow/runtime/graph-model.js";
import type { OutputClassOf } from "./action-script.js";

/**
 * The class each action of the application returns (for `mockAction(A)` / `toHaveReturned`): its
 * declared `output` — a list's element; a `oneOf` (or a polymorphic list) result is the one class
 * whose strict schema accepts the value (assembly guarantees at most one, `[dto.ambiguous-one-of]`).
 */
export function actionOutputClassOf(nodes: readonly RuntimeNode[]): OutputClassOf {
  const outputs = new Map<string, OutputShape>();
  for (const node of nodes) {
    const { declaration } = node;
    if (declaration.kind !== ComponentKind.Action) continue;
    const { output } = declaration.options;
    if (output !== undefined) outputs.set(node.id, output);
  }
  return (action, value) => {
    const output = outputs.get(action);
    if (output === undefined) return undefined;
    if (typeof output === "function") return output;
    if (output.kind === Wrapper.OneOf) return strictMatchOf(output.variants, value);
    return output.variants.length === 1
      ? output.variants[0]
      : strictMatchOf(output.variants, value);
  };
}
