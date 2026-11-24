/**
 * The decision models OpenRouter's Decisions API serves (2026-10): calibrated answers to choice,
 * yes/no (`boolean`) and score questions, the exact cost in every answer. Images: Luna, pplx-decider, Clef.
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

/** The families of decision models, by name (a new version of a family is a decision model too). */
const FAMILIES = [
  "(?:[^/]+\\/)?jev-",
  "openai\\/[^/]+-decisions$",
  "perplexity\\/pplx-decider",
  "cloudflare\\/clef",
  "upstage\\/solar-decide",
  "inception\\/mercury-decide",
].join("|");

/** Model names of the decision families; what the Decisions provider serves. */
export const DECISION_MODEL_PATTERN = new RegExp(`^(?:${FAMILIES})`);

/** Every model name but the decision families' (a chat provider that serves "everything else"). */
export const NOT_A_DECISION_MODEL = new RegExp(`^(?!(?:${FAMILIES}))`);

/** A decision model decides through the Decisions API (`decide`); anything else is a chat model. */
export const isDecisionModel = (model: string): boolean => DECISION_MODEL_PATTERN.test(model);
