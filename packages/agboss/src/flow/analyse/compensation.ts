import type { Class } from "../../components/injection.js";
import { NodeKind } from "../ast.js";
import { declarationOf, type ActionDeclaration } from "../decorators/declaration.js";
import type { ComponentName } from "../registry.js";
import type { FlowGraph, FlowNode } from "./flow-graph.js";
import { classLabel } from "./labels.js";

/**
 * Declared action compensation as the analyser sees it (#339): every action of the graph with
 * `compensateWith` — its undo action and the action that commits it, by name. Only declarations that
 * pass the `action.*` rules take part in the path rules.
 */

/** One undoable action: what undoes it and, with `committedBy`, what commits it. */
export interface UndoableAction {
  readonly action: ComponentName;
  readonly compensator: ComponentName;
  readonly committer?: ComponentName;
}

/** The action declaration of a class; undefined for anything else (or `undefined` itself). */
export function actionDeclarationOf(component: Class | undefined): ActionDeclaration | undefined {
  if (component === undefined) return undefined;
  const declaration = declarationOf(component);
  return declaration?.kind === NodeKind.Action ? declaration : undefined;
}

/** A class as a message names it: its component name, else its class name. */
export const componentLabel = (component: Class | undefined): string =>
  component === undefined
    ? "undefined (a circular import?)"
    : (declarationOf(component)?.options.name ?? classLabel(component));

/** The actions of the graph that declare `compensateWith` or `committedBy`. */
export function compensatingNodes(graph: FlowGraph): readonly FlowNode[] {
  return [...graph.nodes.values()].filter((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Action) return false;
    return "compensateWith" in declaration.options || "committedBy" in declaration.options;
  });
}

/** A node's undo, when it is a well-formed one: an action that is not itself and undoes nothing. */
function validCompensator(
  node: FlowNode,
  declaration: ActionDeclaration,
): ActionDeclaration | undefined {
  const { compensateWith } = declaration.options;
  const compensator = actionDeclarationOf(compensateWith);
  if (compensator === undefined || compensateWith === node.component) return undefined;
  return compensator.options.compensateWith === undefined ? compensator : undefined;
}

/** Every well-formed undoable action of the graph, by its name. */
export function undoableActionsOf(graph: FlowGraph): ReadonlyMap<ComponentName, UndoableAction> {
  const found = new Map<ComponentName, UndoableAction>();
  for (const node of compensatingNodes(graph)) {
    const declaration = actionDeclarationOf(node.component);
    if (declaration === undefined) continue;
    const compensator = validCompensator(node, declaration);
    if (compensator === undefined) continue;
    const committer = actionDeclarationOf(declaration.options.committedBy)?.options.name;
    found.set(node.name, {
      action: node.name,
      compensator: compensator.options.name as ComponentName,
      ...(committer === undefined ? {} : { committer: committer as ComponentName }),
    });
  }
  return found;
}
