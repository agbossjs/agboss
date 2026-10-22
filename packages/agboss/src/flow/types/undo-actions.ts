import { actionDeclarationOf } from "../analyse/compensation.js";
import { NodeKind } from "../ast.js";
import { TablesImport, type ImportTable } from "./imports.js";
import { outputText, producedText, propertyName } from "./shapes.js";
import type { AnalysedWorkflow } from "./tables.js";

/**
 * The undo actions no path of any workflow reaches (#340): the framework runs them itself — a
 * failed join's finished branches — so they are no node, yet `InputOf<X>` / `OutputOf<X>` must type
 * them. Their input is their declared fields, each `Produced<XDto, unknown>`: what the snapshot of
 * the undone step's scope held (`[action.invalid-compensator-input]` proved it there).
 */

/** One off-path undo action's entries. */
export interface UndoActionEntry {
  readonly name: string;
  readonly input: string;
  readonly output: string;
}

/** Every undo action the graphs' actions declare that is no node of any of them, by name. */
export function offPathUndoActions(
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
  isNode: (name: string) => boolean,
): readonly UndoActionEntry[] {
  const found = new Map<string, UndoActionEntry>();
  for (const { analysis } of workflows) {
    for (const node of analysis.graph.nodes.values()) {
      if (node.declaration.kind !== NodeKind.Action) continue;
      const undo = node.declaration.options.compensateWith;
      const declaration = actionDeclarationOf(undo);
      if (undo === undefined || declaration === undefined) continue;
      const { name, input = {}, output } = declaration.options;
      if (isNode(name) || found.has(name)) continue;
      names.ref(undo);
      const fields = Object.entries(input).map(
        ([field, shape]) => `${propertyName(field)}: ${producedText(shape, "unknown", names)}`,
      );
      const inputType =
        fields.length === 0 ? names.use(TablesImport.NoInput) : `{ ${fields.join("; ")} }`;
      found.set(name, { name, input: inputType, output: outputText(output, names) });
    }
  }
  return [...found.values()];
}
