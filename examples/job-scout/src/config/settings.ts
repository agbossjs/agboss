/**
 * Settings the job-scout application and workflow use (the workflow's limits and model providers are
 * in its `settings()`). Costs come from OpenRouter's answers
 * (`model-providers/openrouter.model-provider.ts`).
 */
export const KIMI = "moonshotai/kimi-k2.6";

/** The application's defaults (#261): every workflow takes them, field by field, under its own. */
export const DEFAULTS = {
  // no maxTokens: AGBoss's default ceiling (8192) applies; reasoning and caching: the provider's
  models: { temperature: 0 },
  router: { model: "typesafe/jev-1.13" },
  guardrail: { model: "typesafe/jev-1.13" }, // the guardrails' model — never defaults.router's
  tools: { maxToolCalls: 8 },
  history: { limit: 5 },
} as const;
