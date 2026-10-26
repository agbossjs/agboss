import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

/**
 * No --env, a real run: models through OpenRouter with OPENROUTER_API_KEY (OPENROUTER_BASE_URL
 * optional); the SQLite stores in `.agboss/flow-patterns.sqlite` (git-ignored) unless
 * AGBOSS_SQLITE_PATH says otherwise; the PII key from PII_PSEUDONYM_KEY. Langfuse traces the run
 * when its LANGFUSE_* keys are set, and only then.
 */
export const environment: AppEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL"), // unset → the providers' baseUrl
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: ".agboss/flow-patterns.sqlite" }),
  piiPseudonymKey: secret("PII_PSEUDONYM_KEY"),
};
