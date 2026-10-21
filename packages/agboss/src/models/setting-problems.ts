import { TokenLimit } from "../config/types.js";
import type { ModelCapabilities, ReasoningSupport } from "./capabilities.js";
import type { ModelProblem } from "./problems.js";
import type { PromptCaching } from "./prompt-caching.js";
import { reasoningLabel, type Reasoning, type ReasoningOnOptions } from "./reasoning.js";
import type { ModelUse } from "./uses.js";

/** A use's settings with the provider's reasoning and caching filled in. */
export interface EffectiveSettings {
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
}

type Unsupported = (key: string, value: string, supported: string) => ModelProblem;

const list = (values: readonly string[]): string =>
  values.length === 0 ? "none" : values.join(", ");

/** What the model offers for `Reasoning.on`, as the problem says it. */
const offeredReasoning = (support: ReasoningSupport): string =>
  `efforts ${list(support.efforts)}; budget ${support.budget ? "yes" : "no"}; effort with budget ${support.effortWithBudget ? "yes" : "no"}`;

/** Whether `Reasoning.on({ effort?, budget? })` fits exactly — no nearby setting counts. */
const fitsOn = (reasoning: ReasoningOnOptions, support: ReasoningSupport): boolean =>
  (reasoning.effort === undefined || support.efforts.includes(reasoning.effort)) &&
  (reasoning.budget === undefined || support.budget) &&
  (reasoning.effort === undefined || reasoning.budget === undefined || support.effortWithBudget);

function reasoningProblems(
  reasoning: Reasoning,
  support: ReasoningSupport | undefined,
  problem: (supported: string) => ModelProblem,
): ModelProblem[] {
  if (support === undefined || reasoning.kind === "model-decides") return [];
  if (reasoning.kind === "off") {
    return support.supported && !support.canTurnOff
      ? [problem("reasoning is mandatory, it cannot be turned off")]
      : [];
  }
  if (!support.supported) return [problem("no reasoning")];
  return fitsOn(reasoning, support) ? [] : [problem(offeredReasoning(support))];
}

function cachingProblems(
  caching: PromptCaching,
  capabilities: ModelCapabilities,
  unsupported: Unsupported,
  key: string,
): ModelProblem[] {
  const support = capabilities.promptCaching;
  // "where supported": a model without caching simply gets none
  if (support === undefined || !support.supported || caching.kind === "off") return [];
  const problems: ModelProblem[] = [];
  if (!support.retentions.includes(caching.retention)) {
    problems.push(
      unsupported(`${key}.retention`, caching.retention, `retention ${list(support.retentions)}`),
    );
  }
  const parts = caching.cachedParts.filter((part) => !support.cachedParts.includes(part));
  if (parts.length > 0)
    problems.push(
      unsupported(
        `${key}.cachedParts`,
        parts.join(", "),
        `cached parts ${list(support.cachedParts)}`,
      ),
    );
  return problems;
}

function parameterProblems(
  use: ModelUse,
  capabilities: ModelCapabilities,
  unsupported: Unsupported,
): ModelProblem[] {
  const parameters = capabilities.parameters;
  const settings = use.settings;
  if (parameters === undefined || settings === undefined) return [];
  const takes = (...names: string[]): boolean => names.some((name) => parameters.includes(name));
  return [
    ...(takes("temperature")
      ? []
      : [
          unsupported(
            `${use.key}.temperature`,
            String(settings.temperature),
            `parameters ${list(parameters)}`,
          ),
        ]),
    ...(settings.maxTokens === TokenLimit.MODEL_MAX || takes("max_tokens", "max_completion_tokens")
      ? []
      : [
          unsupported(
            `${use.key}.maxTokens`,
            String(settings.maxTokens),
            `parameters ${list(parameters)}`,
          ),
        ]),
  ];
}

/** Every setting of a chat use its model does not support (`model.unsupported-setting`). */
export function settingProblems(
  use: ModelUse,
  effective: EffectiveSettings,
  capabilities: ModelCapabilities,
): readonly ModelProblem[] {
  const unsupported: Unsupported = (key, value, supported) => ({
    code: "model.unsupported-setting",
    key,
    value,
    model: use.model,
    supported,
  });
  return [
    ...reasoningProblems(effective.reasoning, capabilities.reasoning, (supported) =>
      unsupported(`${use.key}.thinking`, reasoningLabel(effective.reasoning), supported),
    ),
    ...cachingProblems(effective.promptCaching, capabilities, unsupported, `${use.key}.cache`),
    ...parameterProblems(use, capabilities, unsupported),
  ];
}
