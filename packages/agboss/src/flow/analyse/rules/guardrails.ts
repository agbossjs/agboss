import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { AnalysisContext } from "./context.js";

/**
 * `[guardrail.no-model]` (#261): every guard of the workflow (#120 turns them into guardrails) has a
 * model of its own or `defaults.guardrail.model` — of the workflow or its application. A guard never
 * takes `defaults.router.model`, and the framework has no built-in guardrail model.
 */
export function guardrailRules(context: AnalysisContext): readonly RuleViolation[] {
  const { guards, defaults } = context.workflow;
  if (defaults?.guardrail?.model !== undefined) return [];
  const sides = [guards?.input ?? {}, guards?.output ?? {}];
  return sides.flatMap((side) =>
    Object.entries(side).flatMap(([name, guard]) =>
      guard.model === undefined
        ? [
            violation(
              "guardrail.no-model",
              `${name} has no model — set model or defaults.guardrail.model`,
              [name],
            ),
          ]
        : [],
    ),
  );
}
