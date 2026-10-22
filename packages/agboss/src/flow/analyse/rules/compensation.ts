import type { Class } from "../../../components/injection.js";
import { violation, type RuleCode, type RuleViolation } from "../../../graph/rule-error.js";
import type { ActionDeclaration } from "../../decorators/declaration.js";
import type { ComponentName } from "../../registry.js";
import {
  actionDeclarationOf,
  compensatingNodes,
  componentLabel,
  undoableActionsOf,
  type UndoableAction,
} from "../compensation.js";
import {
  CompensationFindingKind,
  walkCompensations,
  type CompensationFinding,
} from "../compensation-walk.js";
import { statesOf, witnessPath } from "../dataflow.js";
import { EdgeKind, outgoingEdges, reachableFrom, type FlowNode } from "../flow-graph.js";
import { shapeLabel } from "../labels.js";
import { stepOf } from "../launches.js";
import { slotOf, slotOfField, SlotStatus, type AbstractScope } from "../scope.js";
import type { AnalysisContext } from "./context.js";

/**
 * Declared action compensation (#339): `@Action({ compensateWith, committedBy })` name `@Action`
 * classes (`[action.compensator-not-an-action]`, `[action.committer-not-an-action]` — an undo is
 * code, never a model call), an action does not undo itself (`[action.self-compensation]`), an undo
 * action is not undone (`[action.compensator-compensates]`, no chains), and the undo reads only what
 * the path holds right after the action (`[action.invalid-compensator-input]`) — what reached the
 * action and what it returned, on every path; `committedBy` without `compensateWith` has no effect
 * (`[action.committer-without-compensator]`, #339 S3). The path rules, from the walk of
 * `compensation-walk.ts`: a side path entered after an undoable action reaches a finish without its
 * undo action (`[flow.uncompensated-action]`); with `committedBy`, a path from the action reaches a
 * finish with neither the committer nor the undo (`[flow.uncommitted-action]`, an error: leaving
 * `committedBy` out says "the finish commits"); undo actions on one path not newest first
 * (`[flow.compensation-out-of-order]`); a committer no path from the action reaches
 * (`[flow.committer-unreachable]`, a warning).
 */

/** `[action.compensator-not-an-action]` / `[action.committer-not-an-action]`. */
function notAnAction(
  node: FlowNode,
  option: "compensateWith" | "committedBy",
  value: Class | undefined,
): readonly RuleViolation[] {
  if (actionDeclarationOf(value) !== undefined) return [];
  const isUndo = option === "compensateWith";
  const code: RuleCode = isUndo
    ? "action.compensator-not-an-action"
    : "action.committer-not-an-action";
  const message =
    `${node.name}: ${option} ${componentLabel(value)} is not an @Action — ` +
    (isUndo
      ? "an undo is code, never a model call: name an @Action class that undoes it"
      : "name the @Action after which nothing undoes it, or leave committedBy out (a finish commits it)");
  return [violation(code, message, [node.name])];
}

/** `[action.self-compensation]` / `[action.compensator-compensates]` of a valid undo action. */
function undoShape(node: FlowNode, compensator: Class, undo: ActionDeclaration): RuleViolation[] {
  if (compensator === node.component) {
    const message = `${node.name}: compensateWith names the action itself — name the @Action that undoes it`;
    return [violation("action.self-compensation", message, [node.name])];
  }
  if (undo.options.compensateWith === undefined) return [];
  const message =
    `${undo.options.name} undoes ${node.name} and declares compensateWith ` +
    `${componentLabel(undo.options.compensateWith)} itself — an undo action is not undone (no ` +
    `chains); remove compensateWith from ${undo.options.name}`;
  return [violation("action.compensator-compensates", message, [node.name, undo.options.name])];
}

/** `[action.committer-without-compensator]`: nothing undoes the action, so nothing commits it. */
function committerWithoutCompensator(node: FlowNode, committer: Class | undefined): RuleViolation {
  const message =
    `${node.name}: committedBy ${componentLabel(committer)} has no effect without compensateWith ` +
    `— nothing undoes ${node.name}, so nothing commits it; add compensateWith (the @Action that ` +
    "undoes it), or remove committedBy";
  return violation("action.committer-without-compensator", message, [node.name]);
}

function declarationRules(node: FlowNode): readonly RuleViolation[] {
  const declaration = actionDeclarationOf(node.component);
  if (declaration === undefined) return [];
  const { options } = declaration;
  const found: RuleViolation[] = [];
  if ("committedBy" in options)
    found.push(...notAnAction(node, "committedBy", options.committedBy));
  if (!("compensateWith" in options)) {
    if ("committedBy" in options)
      found.push(committerWithoutCompensator(node, options.committedBy));
    return found;
  }
  const undo = actionDeclarationOf(options.compensateWith);
  if (undo === undefined || options.compensateWith === undefined)
    return [...found, ...notAnAction(node, "compensateWith", options.compensateWith)];
  return [...found, ...undoShape(node, options.compensateWith, undo)];
}

/** The edges whose scope is the one right after the action: it succeeded, nothing joined yet. */
const AFTER_THE_ACTION: ReadonlySet<EdgeKind> = new Set([
  EdgeKind.Next,
  EdgeKind.Case,
  EdgeKind.Route,
  EdgeKind.Launch,
]);

/** Every scope right after `node`, with the path that reached it. */
function scopesAfter(
  context: AnalysisContext,
  node: ComponentName,
): readonly { readonly scope: AbstractScope; readonly path: readonly ComponentName[] }[] {
  const edges = (outgoingEdges(context.graph).get(node) ?? []).filter((edge) =>
    AFTER_THE_ACTION.has(edge.kind),
  );
  return statesOf(context.dataflow, node).flatMap((state) => {
    const path = witnessPath(context.dataflow, { node, key: state.key });
    return edges.flatMap((edge) =>
      stepOf(edge, state.scope, context.dataflow.provenance).map((step) => ({
        scope: step.scope,
        path,
      })),
    );
  });
}

/** `[action.invalid-compensator-input]`: a required field of the undo with no value right after. */
function inputRules(context: AnalysisContext, node: FlowNode): readonly RuleViolation[] {
  const undo = actionDeclarationOf(actionDeclarationOf(node.component)?.options.compensateWith);
  if (undo === undefined) return [];
  const scopes = scopesAfter(context, node.name);
  return Object.entries(undo.options.input ?? {}).flatMap(([field, shape]) => {
    const slot = slotOfField(shape);
    if (!slot.isRequired) return [];
    const missing = scopes.find(({ scope }) => {
      const state = slotOf(scope, slot.slot);
      return (
        state.status === SlotStatus.Absent ||
        (slot.history !== undefined && state.status === SlotStatus.Outdated)
      );
    });
    if (missing === undefined) return [];
    const message =
      `${node.name}: compensateWith ${undo.options.name} reads ${undo.options.name}.${field} ` +
      `(${shapeLabel(shape)}), which is not on the path right after ${node.name} ` +
      `(${missing.path.join(" → ")}) — an undo reads only what reached the action or what it returned`;
    return [violation("action.invalid-compensator-input", message, [node.name, undo.options.name])];
  });
}

type Undoables = ReadonlyMap<ComponentName, UndoableAction>;

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  const last = items.at(-1) ?? "";
  return items.length <= 1 ? last : `${items.slice(0, -1).join(", ")} and ${last}`;
}

const undoOf = (undoables: Undoables, action: ComponentName): string =>
  undoables.get(action)?.compensator ?? "its undo action";

function findingViolation(finding: CompensationFinding, undoables: Undoables): RuleViolation {
  switch (finding.kind) {
    case CompensationFindingKind.Uncompensated: {
      const { sidePath, finish, missing } = finding;
      const undos = missing.map((action) => `${undoOf(undoables, action)} (compensates ${action})`);
      const fix =
        missing.length === 1
          ? "add it to the side path, or commit the action before it"
          : "add them to the side path, newest first, or commit the actions before it";
      const message = `the ${sidePath.label} reaches ${finish} without ${listed(undos)}; ${fix}`;
      return violation("flow.uncompensated-action", message, [sidePath.node, ...missing, finish]);
    }
    case CompensationFindingKind.Uncommitted: {
      const { action, finish, path } = finding;
      const committer = undoables.get(action)?.committer ?? "its committing action";
      const message =
        `${action} is committed by ${committer}, but the path ${path.join(" → ")} reaches ` +
        `${finish} with neither ${committer} nor ${undoOf(undoables, action)} — add one of them ` +
        "to that path, or leave committedBy out (a finish then commits it)";
      return violation("flow.uncommitted-action", message, [action, finish]);
    }
    case CompensationFindingKind.OutOfOrder: {
      const { older, newer, path } = finding;
      const message =
        `${undoOf(undoables, older)} (compensates ${older}) runs before ` +
        `${undoOf(undoables, newer)} (compensates ${newer}) on the path ${path.join(" → ")} — ` +
        `undo newest first: ${undoOf(undoables, newer)}, then ${undoOf(undoables, older)}`;
      return violation("flow.compensation-out-of-order", message, [older, newer]);
    }
  }
}

function compensationPathRules(
  context: AnalysisContext,
  undoables: Undoables,
): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const finding of walkCompensations(context.graph, undoables)) {
    const problem = findingViolation(finding, undoables);
    found.set(`${problem.code}\u0000${problem.message}`, problem);
  }
  return [...found.values()];
}

/** `[flow.committer-unreachable]`: no path from the action reaches its committing action. */
function compensationPathWarnings(
  context: AnalysisContext,
  undoables: Undoables,
): readonly RuleViolation[] {
  return [...undoables.values()].flatMap(({ action, committer, compensator }) => {
    if (committer === undefined) return [];
    if (reachableFrom([action], context.graph.edges).has(committer)) return [];
    const message =
      `${action} is committed by ${committer}, which no path from ${action} reaches — every ` +
      `path after it must run ${compensator}; add ${committer} after it, or leave committedBy out`;
    return [violation("flow.committer-unreachable", message, [action, committer])];
  });
}

export function compensationRules(context: AnalysisContext): readonly RuleViolation[] {
  const nodes = compensatingNodes(context.graph);
  if (nodes.length === 0) return [];
  const undoables = undoableActionsOf(context.graph);
  return [
    ...nodes.flatMap((node) => [
      ...declarationRules(node),
      ...(undoables.has(node.name) ? inputRules(context, node) : []),
    ]),
    ...compensationPathRules(context, undoables),
  ];
}

export function compensationWarnings(context: AnalysisContext): readonly RuleViolation[] {
  return compensationPathWarnings(context, undoableActionsOf(context.graph));
}
