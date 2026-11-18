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

const policyNames = (classes: readonly Class[]): string =>
  classes.map((cls) => piiPolicyMetaOf(cls)?.name ?? cls.name).join(", ") || "none";

/** What each element and the workflow exclude at their models (#1150), as text. */
function excludedText(bundle: AssembledWorkflow): string {
  const pii = bundle.pii;
  if (pii === undefined) return "";
  const parts = [
    ...(pii.excludes.workflow.length === 0
      ? []
      : [`${policyNames(pii.excludes.workflow)} by the workflow`]),
    ...[...pii.excludes.byElement].flatMap(([element, classes]) =>
      classes.length === 0 ? [] : [`${policyNames(classes)} by ${element}`],
    ),
  ];
  return parts.length === 0 ? "" : ` (excluded: ${parts.join("; ")})`;
}

/**
 * The effective sets of a workflow on each static way into it (#1150) and what is excluded where:
 * what `agboss describe` prints and the start logs, one text per way (a root-only workflow with an
 * exclusion: one for itself).
 */
export function piiChainTexts(bundle: AssembledWorkflow): string[] {
  const pii = bundle.pii;
  if (pii === undefined) return [];
  const excluded = excludedText(bundle);
  const name = bundle.config.name;
  const own =
    excluded === ""
      ? []
      : [
          `${name}: logs and traces masked by ${policyNames(pii.observability)}; models by ${policyNames(pii.model)}${excluded}`,
        ];
  // a way that inherits nothing has the workflow's own sets: nothing to say of it
  const inheriting = pii.chains.filter(
    (chain) => policyNames(chain.observability) !== policyNames(pii.observability),
  );
  const chains = inheriting.map((chain) => {
    const elements = [...chain.byElement]
      .filter(([, classes]) => policyNames(classes) !== policyNames(chain.model))
      .map(([element, classes]) => `; ${element} by ${policyNames(classes)}`)
      .join("");
    return `${name} under ${chain.path.join(" → ")}: logs and traces masked by ${policyNames(chain.observability)}; models by ${policyNames(chain.model)}${elements}${excluded}`;
  });
  return [...own, ...chains];
}

/** `pii policies` — one line per policy; `pii policies none` without one; then each chain (#1150). */
export function piiPolicyLines(bundle: AssembledWorkflow): string[] {
  const policies = describedPiiPoliciesOf(bundle);
  const chains = piiChainTexts(bundle);
  const chainLines =
    chains.length === 0 ? [] : ["pii chains", ...chains.map((line) => `  ${line}`)];
  if (policies.length === 0) return ["pii policies none", ...chainLines];
  return [
    "pii policies",
    ...policies.map((policy) => {
      const model =
        policy.detectWithModel === undefined ? "" : ` · detectWithModel ${policy.detectWithModel}`;
      const logs = policy.masksObservability ? " · masks logs and traces" : "";
      const on = policy.elements.join(", ") || "none";
      return `  ${policy.name} — ${policy.rules.map(ruleText).join(", ")}${model} · on ${on}${logs}`;
    }),
    ...chainLines,
  ];
}
