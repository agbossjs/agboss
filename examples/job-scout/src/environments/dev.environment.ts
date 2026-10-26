import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

/** `npm run chat` (no --env): the public Greenhouse API; records in `.agboss/job-scout.sqlite` (git-ignored) unless AGBOSS_SQLITE_PATH says otherwise. */
export const environment: AppEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL"), // unset → the provider's baseUrl
  greenhouseApiUrl: "https://boards-api.greenhouse.io",
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: ".agboss/job-scout.sqlite" }),
};
