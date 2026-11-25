import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

/**
 * No --env, a real run: models through OpenRouter with OPENROUTER_API_KEY (OPENROUTER_BASE_URL
 * optional). The SQLite stores in `.agboss/flow-patterns.sqlite` (git-ignored) unless
 * AGBOSS_SQLITE_PATH says otherwise, the idempotency key (#825) from AGBOSS_IDEMPOTENCY_SECRET and
 * the PII key from PII_PSEUDONYM_KEY are the storage's (`src/storages/`). A run is traced only when
 * the application is given a `tracerProvider` (`@agboss/langfuse`).
 */
export const environment: AppEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL"), // unset → the providers' baseUrl
};
