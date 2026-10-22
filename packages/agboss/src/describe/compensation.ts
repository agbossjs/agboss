import { NodeKind } from "../flow/ast.js";
import { componentLabel } from "../flow/analyse/compensation.js";
import type { ActionOptions } from "../flow/decorators/action.js";
import type { RuntimeNode } from "../flow/runtime/graph-model.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * Declared compensation in `agboss describe` (#339): each action with `compensateWith` /
 * `committedBy` — `register-offer-action  compensateWith withdraw-offer-action · committedBy
 * confirm-offer-action`, and `--json`'s `ActionSnapshot` on its node.
 */

/** An action's compensation, by component name (`describe --json`). */
export interface ActionSnapshot {
  readonly compensateWith?: string;
  readonly committedBy?: string;
}

function snapshotOf(options: ActionOptions): ActionSnapshot | undefined {
  const { compensateWith, committedBy } = options;
  if (compensateWith === undefined && committedBy === undefined) return undefined;
  return {
    ...(compensateWith === undefined ? {} : { compensateWith: componentLabel(compensateWith) }),
    ...(committedBy === undefined ? {} : { committedBy: componentLabel(committedBy) }),
  };
}

/** The node's compensation, when it is an action that declares one. */
export const actionSnapshotOf = (node: RuntimeNode): ActionSnapshot | undefined =>
  node.declaration.kind === NodeKind.Action ? snapshotOf(node.declaration.options) : undefined;

/** `compensateWith withdraw-offer-action · committedBy confirm-offer-action`. */
const compensationLabel = (snapshot: ActionSnapshot): string =>
  [
    ...(snapshot.compensateWith === undefined ? [] : [`compensateWith ${snapshot.compensateWith}`]),
    ...(snapshot.committedBy === undefined ? [] : [`committedBy ${snapshot.committedBy}`]),
  ].join(" · ");

/** A launched action's undo runs by itself when its join fails (#340): no path can say it. */
const automaticLabel = (bundle: AssembledWorkflow, node: RuntimeNode, snapshot: ActionSnapshot) =>
  snapshot.compensateWith !== undefined && bundle.graph.branchNodes.has(node.id)
    ? "  (on a failed join: automatic)"
    : "";

/** The `actions` section: every action that declares compensation; none → no section. */
export function compensationLines(bundle: AssembledWorkflow): string[] {
  const lines = [...bundle.graph.nodes.values()].flatMap((node) => {
    const snapshot = actionSnapshotOf(node);
    if (snapshot === undefined) return [];
    const automatic = automaticLabel(bundle, node, snapshot);
    return [`  ${node.id}  ${compensationLabel(snapshot)}${automatic}`];
  });
  return lines.length === 0 ? [] : ["actions", ...lines];
}
