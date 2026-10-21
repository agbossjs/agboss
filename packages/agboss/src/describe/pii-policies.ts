import type { Class } from "../components/injection.js";
import { PiiActionKind, actionText, type AnyPiiAction } from "../pii/actions.js";
import { isCustomPolicy } from "../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * Each PII policy of a workflow as `agboss describe` shows it (#120, #268 AC4): its rules — what
 * each kind or group becomes — a block rule's refusal (the text, or `ClassName.refusal()` when the
 * class computes it), a project's own detector, the model that finds free-text kinds, and the
 * agents and routers whose models it covers. Read from the decorators only.
 */

/** One rule of a policy: the kind or group, what happens to it, and a block rule's refusal. */
export interface DescribedPiiRule {
  /** The kind or group (`email`, `contact`), or `findMatches()` for a project's own detector. */
  readonly target: string;
  /** `replaceWithToken()`, `replacePart({"keepLast":4})`, `blockWithRefusal()`. */
  readonly action: string;
  /** A block rule's refusal: its text, or `ClassName.refusal()`; absent for a masking rule. */
  readonly refusal?: string;
}

/** One policy of a workflow. */
export interface DescribedPiiPolicy {
  readonly name: string;
  /** The class's name (a refusal computed by it is `ClassName.refusal()`). */
  readonly className: string;
  readonly rules: readonly DescribedPiiRule[];
  /** `detectWithModel` of a declarative policy. */
  readonly detectWithModel?: string;
  /** The agents and routers whose models it covers, by name. */
  readonly elements: readonly string[];
  /** Whether it masks the workflow's logs, traces, events and records (an application or workflow policy). */
  readonly masksObservability: boolean;
}

/** A block rule's refusal: the rule's own text, else the class's `refusal(kind)`. */
function refusalOf(cls: Class, action: AnyPiiAction): string | undefined {
  if (action.kind !== PiiActionKind.BlockWithRefusal) return undefined;
  return action.refusal === undefined ? `${cls.name}.refusal()` : JSON.stringify(action.refusal);
}

/** A block rule is shown by its kind; the refusal is its own field. */
const ruleActionText = (action: AnyPiiAction): string =>
  action.kind === PiiActionKind.BlockWithRefusal ? "blockWithRefusal()" : actionText(action);

function rulesOf(cls: Class): readonly DescribedPiiRule[] {
  const meta = piiPolicyMetaOf(cls);
  if (meta === undefined) return [];
  if (isCustomPolicy(meta)) return [{ target: "findMatches()", action: actionText(meta.action) }];
  return meta.rules.map((rule) => {
    const refusal = refusalOf(cls, rule.action);
    return {
      target: rule.target,
      action: ruleActionText(rule.action),
      ...(refusal === undefined ? {} : { refusal }),
    };
  });
}

/** The workflow's PII policies, in the order they were assembled. */
export function describedPiiPoliciesOf(bundle: AssembledWorkflow): readonly DescribedPiiPolicy[] {
  const { pii } = bundle;
  if (pii === undefined) return [];
  return pii.classes.flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined) return [];
    const elements = [...pii.byElement]
      .filter(([, classes]) => classes.includes(cls))
      .map(([element]) => element);
    const detectWithModel = isCustomPolicy(meta) ? undefined : meta.detectWithModel;
    return [
      {
        name: meta.name,
        className: cls.name,
        rules: rulesOf(cls),
        ...(detectWithModel === undefined ? {} : { detectWithModel }),
        elements,
        masksObservability: pii.observability.includes(cls),
      },
    ];
  });
}

const ruleText = (rule: DescribedPiiRule): string =>
  `${rule.target}: ${rule.action}${rule.refusal === undefined ? "" : ` · refusal: ${rule.refusal}`}`;

/** `pii policies` — one line per policy; `pii policies none` without one. */
export function piiPolicyLines(bundle: AssembledWorkflow): string[] {
  const policies = describedPiiPoliciesOf(bundle);
  if (policies.length === 0) return ["pii policies none"];
  return [
    "pii policies",
    ...policies.map((policy) => {
      const model =
        policy.detectWithModel === undefined ? "" : ` · detectWithModel ${policy.detectWithModel}`;
      const logs = policy.masksObservability ? " · masks logs and traces" : "";
      const on = policy.elements.join(", ") || "none";
      return `  ${policy.name} — ${policy.rules.map(ruleText).join(", ")}${model} · on ${on}${logs}`;
    }),
  ];
}
