import { compareNames } from "../llm/canonical-order.js";
import type { DecisionQuestion } from "../llm/decisions.js";
import { createJevClient } from "../llm/jev-client.js";
import { minutes, seconds } from "../units/index.js";
import type { ModelCapabilities } from "./capabilities.js";
import { ModelCost } from "./cost.js";
import { DECISION_MODEL_PATTERN, DECISION_MODELS } from "./decision-models.js";
import type { DecideRequest, ModelProviderHandler } from "./handler.js";
import { ModelProvider } from "./model-provider.decorator.js";
import { PromptCaching } from "./prompt-caching.js";
import { Reasoning } from "./reasoning.js";
import { RetryPolicy, TRANSIENT_FAILURES } from "./retry-policy.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The built-ins' base URL field: `openRouterBaseUrl` of the application's environment, when it
 * declares one (`env("OPENROUTER_BASE_URL", { default: OPENROUTER_BASE_URL })` — a proxy, a stub).
 */
export const OPENROUTER_BASE_URL_FIELD = "openRouterBaseUrl";

/** A choice question's options sorted by name; yes/no and score questions as asked (a scale is ordered). */
function sortedOptions(question: DecisionQuestion): DecisionQuestion {
  if (question.type !== "choice") return question;
  const criteria = Object.entries(question.criteria).sort(([a], [b]) => compareNames(a, b));
  return { ...question, criteria: Object.fromEntries(criteria) };
}

/**
 * The built-ins' key: the `Secret` field `openRouterApiKey` of the application's environment
 * (`openRouterApiKey: secret("OPENROUTER_API_KEY")`, #266 S73 c).
 */
export const OPENROUTER_API_KEY_FIELD = "openRouterApiKey";

/** Jev's models (a subset of `DECISION_MODELS`, every model the Decisions API serves). */
export const JEV_MODELS: readonly string[] = ["typesafe/jev-1.13", "typesafe/jev-router"];

/**
 * OpenRouter's Decisions API: every decision model (`DECISION_MODELS` — Jev, GPT-6 Luna Decisions,
 * pplx-decider, Clef, Solar Decide, Mercury Decide) for routers, guards and judges — choice, yes/no
 * and score questions, image parts, the exact cost in every answer. Decisions only, no chat. A
 * subclass lists more models (`override readonly knownModels`).
 */
@ModelProvider({
  name: "decisions-model-provider",
  description: "Decision models on OpenRouter's Decisions API",
  serves: [DECISION_MODEL_PATTERN],
  baseUrl: OPENROUTER_BASE_URL,
  baseUrlField: OPENROUTER_BASE_URL_FIELD,
  apiKey: OPENROUTER_API_KEY_FIELD,
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(10),
    jitter: true,
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class DecisionsModelProvider implements ModelProviderHandler {
  readonly knownModels: readonly string[] = DECISION_MODELS;

  /** Choice options sorted by name: declaration order changes neither the request nor its fingerprint. */
  routeTo({ decision, connection }: DecideRequest): Promise<unknown> {
    const questions = Object.fromEntries(
      Object.entries(decision.questions).map(([id, question]) => [id, sortedOptions(question)]),
    );
    const client = createJevClient(
      { apiKey: connection.apiKey ?? "", baseUrl: connection.baseUrl },
      connection.fetch,
    );
    return client({ ...decision, questions });
  }

  capabilities(model: string): Promise<ModelCapabilities | undefined> {
    return Promise.resolve(this.knownModels.includes(model) ? { model } : undefined);
  }
}
