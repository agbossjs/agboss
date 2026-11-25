import { isModelGuardrail } from "../guardrails/loaded.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * Each guardrail (#120): its side and threshold, its model and where it came from — a code one
 * (#383) code, no threshold, no model —, its refusal — the text, or `Class.refusal()`
 * when the class computes it — and the agents and routers it guards.
 */
export function guardrailLines(bundle: AssembledWorkflow): string[] {
  const assembled = bundle.guardrails;
  if (assembled === undefined || assembled.guardrails.length === 0) return ["guardrails none"];
  const users = (type: unknown): string =>
    [...assembled.byElement]
      .filter(([, sides]) => [...sides.input, ...sides.output].some((g) => g.type === type))
      .map(([name]) => name)
      .join(", ") || "none";
  return [
    "guardrails",
    ...assembled.guardrails.map((g) => {
      const decision = isModelGuardrail(g)
        ? `${g.side} ≥${String(g.threshold)} · ${g.model} (${g.isOwnModel ? "own" : "defaults.guardrail"})`
        : `${g.side} · code`;
      const refusal =
        g.refusal === undefined ? `${g.type.name}.refusal()` : JSON.stringify(g.refusal);
      return `  ${g.name} — ${decision} · refusal: ${refusal} · on ${users(g.type)}`;
    }),
  ];
}

/** The guardrails in effect at one agent or model router, by side. */
export interface ElementGuardrailsSnapshot {
  readonly input: readonly string[];
  readonly output: readonly string[];
}

export function guardrailsAt(
  bundle: AssembledWorkflow,
  element: string,
): ElementGuardrailsSnapshot {
  const sides = bundle.guardrails?.byElement.get(element);
  return {
    input: (sides?.input ?? []).map((guardrail) => guardrail.name),
    output: (sides?.output ?? []).map((guardrail) => guardrail.name),
  };
}
