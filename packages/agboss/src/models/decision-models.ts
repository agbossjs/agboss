/**
 * The decision models OpenRouter's Decisions API serves (2026-10): calibrated answers to choice,
 * yes/no (`boolean`) and score questions, the exact cost in every answer. Images: Luna, pplx-decider, Clef.
 * What a model is, is told by its provider's driver (`DecisionsDriver`), never by its name.
 */
export const DECISION_MODELS: readonly string[] = [
  "typesafe/jev-1.13",
  "typesafe/jev-router",
  "openai/gpt-6-luna-decisions",
  "perplexity/pplx-decider-v1-27b",
  "perplexity/pplx-decider-v1.1-27b",
  "cloudflare/clef",
  "cloudflare/clef-flash",
  "cloudflare/clef-omni",
  "upstage/solar-decide",
  "inception/mercury-decide",
];
