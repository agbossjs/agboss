import type { Class } from "../components/injection.js";
import {
  guardrailMetaOf,
  isCodeGuardrail,
  type GuardrailMeta,
  type ModelGuardrailMeta,
} from "../components/policy-decorators.js";
import { hasPrompt } from "../components/prompt-source.js";
import { kebabNameProblem } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The assembly checks of a guardrail class (#120): its name is kebab-case, it has a
 * question (`prompt`), a threshold in (0, 1], one refusal — the decorator's text or
 * the class's `refusal(content)`, never both and never neither — and a
 * model: its own or `defaults.guardrail.model` of the workflow (or its application). A guardrail
 * never takes `defaults.router.model`, and the framework has no built-in guardrail model. A code
 * guardrail (#383, no question, threshold or model) has no question, threshold or model — its class's `check(text)`
 * decides (`[guardrail.missing-handler]` without one); its forbidden options do not compile.
 */

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
  // a code guardrail may name no refusal: its blocked(refusal) does, else it fails closed (#1289)
  if (!hasText && !hasMethod && !isCodeGuardrail(meta))
    return [
      violation(
        "guardrail.missing-refusal",
        `${meta.name}: no refusal — give the decorator { refusal: "…" } or a refusal(content) method (GuardrailRefusal)`,
        [cls.name],
      ),
    ];
  return [];
}

function nameViolations(cls: Class, meta: GuardrailMeta): RuleViolation[] {
  const problem = kebabNameProblem(meta.name, "a guardrail");
  return problem === undefined ? [] : [violation(problem.code, problem.message, [cls.name])];
}

/** A code guardrail's class has its `check(content)`. */
function handlerViolations(cls: Class, meta: GuardrailMeta): RuleViolation[] {
  const check: unknown = Reflect.get(cls.prototype as object, "check");
  if (typeof check === "function") return [];
  const message = `${meta.name}: decided by code (it sets no prompt, threshold or model) but ${cls.name} has no check(content) method`;
  return [violation("guardrail.missing-handler", message, [cls.name])];
}

function questionViolations(cls: Class, meta: ModelGuardrailMeta): RuleViolation[] {
  const found: RuleViolation[] = [];
  if (!hasPrompt(meta.prompt))
    found.push(
      violation(
        "guardrail.no-prompt",
        `${meta.name}: no question to ask — set prompt (yes blocks)`,
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
  hasProvider: boolean,
): RuleViolation[] {
  if (guardrailModelOf(meta, defaultModel) !== undefined) return [];
  // a provider in the cascade names the model nothing else does (#1313)
  if (hasProvider || meta.modelProvider !== undefined) return [];
  const where = workflow === undefined ? "" : `${workflow}: `;
  const message = `${where}${meta.name} has no model and no modelProvider — set model or defaults.guardrail.model, or modelProvider on it, its @Workflow or its @Application`;
  return [violation("model.missing-provider", message, [cls.name])];
}

/** Every rule the guardrail classes break, all at once; `workflow` names where a model is missing. */
export function guardrailViolations(
  classes: readonly Class[],
  defaultModel: string | undefined,
  workflow?: string,
  hasProvider = false,
): RuleViolation[] {
  return classes.flatMap((cls) => {
    const meta = guardrailMetaOf(cls);
    if (meta === undefined) return [];
    const common = [...nameViolations(cls, meta), ...refusalViolations(cls, meta)];
    if (isCodeGuardrail(meta)) return [...common, ...handlerViolations(cls, meta)];
    return [
      ...common,
      ...questionViolations(cls, meta),
      ...modelViolations(cls, meta, defaultModel, workflow, hasProvider),
    ];
  });
}
