import type { Class } from "../components/injection.js";
import {
  guardrailMetaOf,
  isCodeGuardrail,
  type GuardrailMeta,
  type ModelGuardrailMeta,
} from "../components/policy-decorators.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The assembly checks of a guardrail class (#120): its name ends with `-guardrail`, it has a
 * question (`prompt` / `promptUrls`), a threshold in (0, 1], one refusal — the decorator's text or
 * the class's `refusal()` (`implements GuardrailRefusal`), never both and never neither — and a
 * model: its own or `defaults.guardrail.model` of the workflow (or its application). A guardrail
 * never takes `defaults.router.model`, and the framework has no built-in guardrail model. A code
 * guardrail (`DecidedBy.Code`, #383) has no question, threshold or model — its class's `check(text)`
 * decides (`[guardrail.missing-handler]` without one); its forbidden options do not compile.
 */

const SUFFIX = "-guardrail";

const hasRefusalMethod = (cls: Class): boolean =>
  typeof (cls.prototype as { readonly refusal?: unknown } | undefined)?.refusal === "function";

function refusalViolations(cls: Class, meta: GuardrailMeta): RuleViolation[] {
  const hasText = meta.refusal !== undefined;
  const hasMethod = hasRefusalMethod(cls);
  if (hasText && hasMethod)
    return [
      violation(
        "guardrail.refusal-twice",
        `${meta.name}: refusal is both a text in the decorator and ${cls.name}.refusal() — keep one`,
        [cls.name],
      ),
    ];
  if (!hasText && !hasMethod)
    return [
      violation(
        "guardrail.missing-refusal",
        `${meta.name}: no refusal — give the decorator { refusal: "…" } or implement GuardrailRefusal (refusal())`,
        [cls.name],
      ),
    ];
  return [];
}

function nameViolations(cls: Class, meta: GuardrailMeta): RuleViolation[] {
  return meta.name.endsWith(SUFFIX)
    ? []
    : [
        violation("name.kind-suffix", `${meta.name}: a guardrail's name ends with ${SUFFIX}`, [
          cls.name,
        ]),
      ];
}

/** A code guardrail's class has its `check(text)` (`implements GuardrailHandler`). */
function handlerViolations(cls: Class, meta: GuardrailMeta): RuleViolation[] {
  const check: unknown = Reflect.get(cls.prototype as object, "check");
  if (typeof check === "function") return [];
  const message = `${meta.name}: decided by code (DecidedBy.Code) but ${cls.name} has no check(text) method — implements GuardrailHandler`;
  return [violation("guardrail.missing-handler", message, [cls.name])];
}

function questionViolations(cls: Class, meta: ModelGuardrailMeta): RuleViolation[] {
  const found: RuleViolation[] = [];
  if ((meta.prompt ?? "") === "" && (meta.promptUrls ?? []).length === 0)
    found.push(
      violation(
        "guardrail.no-prompt",
        `${meta.name}: no question to ask — set prompt or promptUrls (yes blocks)`,
        [cls.name],
      ),
    );
  if (!(meta.threshold > 0 && meta.threshold <= 1))
    found.push(
      violation(
        "guardrail.threshold-invalid",
        `${meta.name}: threshold ${String(meta.threshold)} — a probability above 0, at most 1`,
        [cls.name],
      ),
    );
  return found;
}

/** The model a guardrail asks: its own, else the workflow's `defaults.guardrail.model`. */
export const guardrailModelOf = (
  meta: ModelGuardrailMeta,
  defaultModel: string | undefined,
): string | undefined => meta.model ?? defaultModel;

function modelViolations(
  cls: Class,
  meta: ModelGuardrailMeta,
  defaultModel: string | undefined,
  workflow: string | undefined,
): RuleViolation[] {
  if (guardrailModelOf(meta, defaultModel) !== undefined) return [];
  const where = workflow === undefined ? "" : `${workflow}: `;
  const message = `${where}${meta.name} has no model — set model or defaults.guardrail.model`;
  return [violation("guardrail.no-model", message, [cls.name])];
}

/** Every rule the guardrail classes break, all at once; `workflow` names where a model is missing. */
export function guardrailViolations(
  classes: readonly Class[],
  defaultModel: string | undefined,
  workflow?: string,
): RuleViolation[] {
  return classes.flatMap((cls) => {
    const meta = guardrailMetaOf(cls);
    if (meta === undefined) return [];
    const common = [...nameViolations(cls, meta), ...refusalViolations(cls, meta)];
    if (isCodeGuardrail(meta)) return [...common, ...handlerViolations(cls, meta)];
    return [
      ...common,
      ...questionViolations(cls, meta),
      ...modelViolations(cls, meta, defaultModel, workflow),
    ];
  });
}
