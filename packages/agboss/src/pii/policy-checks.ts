import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { PiiActionKind, actionText, isSameAction, type AnyPiiAction } from "./actions.js";
import { isPiiGroup, MODEL_ONLY_KINDS, type PiiKind } from "./kinds.js";
import {
  isCustomPolicy,
  type DeclarativePiiPolicyMeta,
  type PiiPolicyMeta,
} from "./pii-policy.decorator.js";
import { kindActionsOf } from "./policy-rules.js";

/** The assembly checks of `@PiiPolicy` classes (#120): names, refusals, model kinds, conflicts. */

/** A class's `@PiiPolicy` record, if it has one. */
export const piiPolicyMetaOf = (cls: Class): PiiPolicyMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "pii-policy" ? component.meta : undefined;
};

const hasRefusalMethod = (cls: Class): boolean =>
  typeof (cls.prototype as { readonly refusal?: unknown } | undefined)?.refusal === "function";

const isBlockWithoutText = (action: AnyPiiAction): boolean =>
  action.kind === PiiActionKind.BlockWithRefusal && action.refusal === undefined;

function refusalViolations(cls: Class, meta: DeclarativePiiPolicyMeta): RuleViolation[] {
  const needsMethod = meta.rules.some((rule) => isBlockWithoutText(rule.action));
  const hasMethod = hasRefusalMethod(cls);
  if (needsMethod && !hasMethod)
    return [
      violation(
        "pii.missing-refusal",
        `${meta.name}: a blockWithRefusal() rule has no text — give it { refusal } or implement PiiRefusal (refusal(kind))`,
        [cls.name],
      ),
    ];
  if (!needsMethod && hasMethod)
    return [
      violation(
        "pii.unused-refusal",
        `${meta.name}: refusal(kind) is never used — every block rule has its own text, or there is none`,
        [cls.name],
      ),
    ];
  return [];
}

function modelViolations(cls: Class, meta: DeclarativePiiPolicyMeta): RuleViolation[] {
  if (meta.detectWithModel !== undefined) return [];
  const kinds = meta.rules.flatMap((rule) =>
    !isPiiGroup(rule.target) && MODEL_ONLY_KINDS.has(rule.target) ? [rule.target] : [],
  );
  return kinds.map((kind) =>
    violation(
      "pii.kind-needs-model",
      `${meta.name}: ${kind} has no format to detect — set detectWithModel to find it in free text`,
      [cls.name],
    ),
  );
}

function ownViolations(cls: Class, meta: PiiPolicyMeta): RuleViolation[] {
  const name = meta.name.endsWith("-pii-policy")
    ? []
    : [
        violation("name.kind-suffix", `${meta.name}: a PII policy's name ends with -pii-policy`, [
          cls.name,
        ]),
      ];
  if (isCustomPolicy(meta)) return name;
  const own = kindActionsOf(meta.rules).conflicts.map((conflict) =>
    violation(
      "pii.conflicting-rules",
      `${meta.name}: ${conflict.kind} has two actions — ${actionText(conflict.actions[0])} and ${actionText(conflict.actions[1])}`,
      [cls.name],
    ),
  );
  return [...name, ...own, ...refusalViolations(cls, meta), ...modelViolations(cls, meta)];
}

/** The rules each policy class breaks on its own. */
export const policyViolations = (classes: readonly Class[]): RuleViolation[] =>
  classes.flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    return meta === undefined ? [] : ownViolations(cls, meta);
  });

/** One kind's action in one policy. */
interface KindUse {
  readonly policy: string;
  readonly action: AnyPiiAction;
}

/**
 * After adding up: two policies with different actions for one kind (#120 AC6) — the kind, the
 * actions and the policies named. No "strictest wins", no "first wins".
 */
export function conflictViolations(where: string, classes: readonly Class[]): RuleViolation[] {
  const uses = new Map<PiiKind, KindUse[]>();
  for (const cls of classes) {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined || isCustomPolicy(meta)) continue;
    for (const [kind, action] of kindActionsOf(meta.rules).actions)
      uses.set(kind, [...(uses.get(kind) ?? []), { policy: meta.name, action }]);
  }
  return [...uses].flatMap(([kind, list]) => {
    const [first] = list;
    const other = list.find(
      (use) => first !== undefined && !isSameAction(use.action, first.action),
    );
    if (first === undefined || other === undefined) return [];
    return [
      violation(
        "pii.conflicting-rules",
        `${where}: ${kind} is ${actionText(first.action)} in ${first.policy} but ${actionText(other.action)} in ${other.policy}`,
        [where, first.policy, other.policy],
      ),
    ];
  });
}
