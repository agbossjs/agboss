import type { AnyPiiAction } from "./actions.js";
import { isPiiGroup, kindsOf, type PiiKind, type PiiTarget } from "./kinds.js";
import type { PiiRule } from "./pii-policy.decorator.js";

/**
 * What one declarative policy does per kind: only the kinds its rules name, a kind rule over a
 * group rule (#120 AC3). A policy names each kind or group once (`[pii.duplicate-target]`, #1301):
 * a group never shares a kind with another, so a policy's own rules never conflict.
 */

/** The policy's action per kind. */
export interface KindActions {
  readonly actions: ReadonlyMap<PiiKind, AnyPiiAction>;
}

/** The action of every kind the rules name: group rules first, kind rules over them. */
export function kindActionsOf(rules: readonly PiiRule[]): KindActions {
  const actions = new Map<PiiKind, AnyPiiAction>();
  const ordered = [
    ...rules.filter((rule) => isPiiGroup(rule.target)),
    ...rules.filter((rule) => !isPiiGroup(rule.target)),
  ];
  for (const rule of ordered)
    for (const kind of kindsOf(rule.target)) actions.set(kind, rule.action);
  return { actions };
}

/** The targets more than one rule names, each once, in the order of their first rule. */
export function duplicateTargetsOf(rules: readonly PiiRule[]): readonly PiiTarget[] {
  const seen = new Set<PiiTarget>();
  const duplicates = new Set<PiiTarget>();
  for (const { target } of rules) {
    if (seen.has(target)) duplicates.add(target);
    seen.add(target);
  }
  return [...duplicates];
}
