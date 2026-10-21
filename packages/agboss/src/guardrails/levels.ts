import type { Class } from "../components/injection.js";
import { guardrailMetaOf, GuardrailSide } from "../components/policy-decorators.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The guardrails in effect per agent and model router (#120): lists add up `@Application` →
 * `@Workflow` → `@Agent` / `@Router`; removal is explicit (`excludeGuardrails`), and excluding one
 * that is not inherited is an assembly error. An agent takes both sides; a model router reads its
 * input only, so it takes the input guardrails — an `@OutputGuardrail` listed on a router itself is
 * `[guardrail.output-on-router]`; a code router calls no model, so its own list is
 * `[guardrail.no-model-call]`. A child workflow gets its own workflow's lists over the
 * application's — never its parent's.
 */

/** Which model an element has: an agent's loop, a model router's decision, or none (code). */
export enum GuardedElementKind {
  Agent = "agent",
  ModelRouter = "model-router",
  CodeRouter = "code-router",
}

/** One agent's or router's own guardrail settings. */
export interface GuardedElement {
  readonly name: string;
  readonly kind: GuardedElementKind;
  readonly guardrails?: readonly Class[];
  readonly excludeGuardrails?: readonly Class[];
}

/** The lists of one workflow, by level. */
export interface GuardrailLevels {
  readonly application: readonly Class[];
  readonly workflow: readonly Class[];
  readonly workflowName: string;
  readonly elements: readonly GuardedElement[];
}

/** The guardrail classes of one element, by side, in list order. */
export interface ElementGuardrailClasses {
  readonly input: readonly Class[];
  readonly output: readonly Class[];
}

/** What the levels give: each element's guardrails, every class listed, the rules broken. */
export interface EffectiveGuardrails {
  readonly byElement: ReadonlyMap<string, ElementGuardrailClasses>;
  /** Every guardrail class any level lists (the container creates them). */
  readonly classes: readonly Class[];
  readonly violations: readonly RuleViolation[];
}

const unique = (classes: readonly Class[]): Class[] => [...new Set(classes)];

const sideOf = (cls: Class): GuardrailSide | undefined => guardrailMetaOf(cls)?.side;

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

function notGuardrails(classes: readonly Class[], where: string, list: string): RuleViolation[] {
  return classes.flatMap((cls) =>
    sideOf(cls) === undefined
      ? [
          violation(
            "guardrail.not-a-guardrail",
            `${where}: ${nameOf(cls)} in ${list} is not an @InputGuardrail / @OutputGuardrail class`,
            [nameOf(cls)],
          ),
        ]
      : [],
  );
}

function ownListViolations(element: GuardedElement): RuleViolation[] {
  const own = element.guardrails ?? [];
  if (element.kind === GuardedElementKind.CodeRouter && own.length > 0)
    return [
      violation(
        "guardrail.no-model-call",
        `${element.name}: a code router calls no model — its guardrails would check nothing; list them on the agents or routers whose model reads the text`,
        [element.name],
      ),
    ];
  if (element.kind !== GuardedElementKind.ModelRouter) return [];
  return own.flatMap((cls) =>
    sideOf(cls) === GuardrailSide.Output
      ? [
          violation(
            "guardrail.output-on-router",
            `${element.name}: ${nameOf(cls)} is an @OutputGuardrail — a router gives no answer to check; list it on an agent`,
            [element.name, nameOf(cls)],
          ),
        ]
      : [],
  );
}

function excludeViolations(element: GuardedElement, inherited: readonly Class[]): RuleViolation[] {
  return (element.excludeGuardrails ?? []).flatMap((cls) =>
    inherited.includes(cls)
      ? []
      : [
          violation(
            "guardrail.exclude-not-inherited",
            `${element.name}: excludeGuardrails lists ${nameOf(cls)}, which neither its application nor its workflow lists`,
            [element.name, nameOf(cls)],
          ),
        ],
  );
}

/** The element's classes by side: inherited and own, minus the excluded — what its model takes. */
function classesOf(element: GuardedElement, inherited: readonly Class[]): ElementGuardrailClasses {
  if (element.kind === GuardedElementKind.CodeRouter) return { input: [], output: [] };
  const excluded = element.excludeGuardrails ?? [];
  const all = unique([...inherited, ...(element.guardrails ?? [])]).filter(
    (cls) => !excluded.includes(cls),
  );
  const input = all.filter((cls) => sideOf(cls) === GuardrailSide.Input);
  const output =
    element.kind === GuardedElementKind.Agent
      ? all.filter((cls) => sideOf(cls) === GuardrailSide.Output)
      : [];
  return { input, output };
}

/** Each element's guardrails and every rule the lists break, all at once. */
export function effectiveGuardrails(levels: GuardrailLevels): EffectiveGuardrails {
  const inherited = unique([...levels.application, ...levels.workflow]);
  const violations: RuleViolation[] = notGuardrails(inherited, levels.workflowName, "guardrails");
  const byElement = new Map<string, ElementGuardrailClasses>();
  for (const element of levels.elements) {
    violations.push(...notGuardrails(element.guardrails ?? [], element.name, "guardrails"));
    violations.push(...ownListViolations(element));
    violations.push(...excludeViolations(element, inherited));
    byElement.set(element.name, classesOf(element, inherited));
  }
  const listed = [...inherited, ...levels.elements.flatMap((element) => element.guardrails ?? [])];
  const classes = unique(listed).filter((cls) => sideOf(cls) !== undefined);
  return { byElement, classes, violations };
}
