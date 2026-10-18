import { env, secret } from "agboss";
import type { AppEnvironment } from "./app.environment.js";

/** `--env staging`: the board API from the deployment (OPENROUTER_API_KEY, GREENHOUSE_API_URL and AGBOSS_SQLITE_PATH must be set). */
export const environment: AppEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  openRouterBaseUrl: env("OPENROUTER_BASE_URL", { default: "https://openrouter.ai/api/v1" }),
  greenhouseApiUrl: env("GREENHOUSE_API_URL"),
  sqlitePath: env("AGBOSS_SQLITE_PATH"),
};
