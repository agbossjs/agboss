import { env, secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

/**
 * `--env prod`: the deployment's key and records file; `agboss check --env prod` lists the process
 * variables to set at deploy (`--set-secrets OPENROUTER_API_KEY=…`, `--set-env-vars …`), never a
 * value.
 */
export const environment: AppEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL"), // unset → the provider's baseUrl
  greenhouseApiUrl: "https://boards-api.greenhouse.io",
  sqlitePath: env("AGBOSS_SQLITE_PATH", { default: "/var/lib/job-scout/job-scout.sqlite" }),
};
