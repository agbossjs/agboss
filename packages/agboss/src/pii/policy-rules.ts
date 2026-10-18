import { isSameAction, type AnyPiiAction } from "./actions.js";
import { isPiiGroup, kindsOf, type PiiKind } from "./kinds.js";
import type { PiiRule } from "./pii-policy.decorator.js";

/**
 * What one declarative policy does per kind: only the kinds its rules name, a kind rule over a
 * group rule (#120 AC3). Two rules of one level with different actions for one kind conflict.
 */

/** Two actions of one policy for one kind. */
export interface RuleConflict {
  readonly kind: PiiKind;
  readonly actions: readonly [AnyPiiAction, AnyPiiAction];
}

/** The policy's action per kind, and its own conflicts. */
export interface KindActions {
  readonly actions: ReadonlyMap<PiiKind, AnyPiiAction>;
  readonly conflicts: readonly RuleConflict[];
}

function addLevel(
  rules: readonly PiiRule[],
  actions: Map<PiiKind, AnyPiiAction>,
  conflicts: RuleConflict[],
): void {
  const level = new Map<PiiKind, AnyPiiAction>();
  for (const rule of rules) {
    for (const kind of kindsOf(rule.target)) {
      const earlier = level.get(kind);
      if (earlier !== undefined && !isSameAction(earlier, rule.action))
        conflicts.push({ kind, actions: [earlier, rule.action] });
      level.set(kind, rule.action);
    }
  }
  for (const [kind, action] of level) actions.set(kind, action);
}

/** The action of every kind the rules name: group rules first, kind rules over them. */
export function kindActionsOf(rules: readonly PiiRule[]): KindActions {
  const actions = new Map<PiiKind, AnyPiiAction>();
  const conflicts: RuleConflict[] = [];
  addLevel(
    rules.filter((rule) => isPiiGroup(rule.target)),
    actions,
    conflicts,
  );
  addLevel(
    rules.filter((rule) => !isPiiGroup(rule.target)),
    actions,
    conflicts,
  );
  return { actions, conflicts };
}
