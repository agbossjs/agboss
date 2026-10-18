import { env, secret } from "../../../../../src/index.js";
import type { SettingsEnvironment } from "./app.environment.js";

export const environment: SettingsEnvironment = {
  apiUrl: "https://api.dev.example.com",
  apiToken: secret("FIXTURE_API_TOKEN"),
  currency: env("FIXTURE_CURRENCY", { default: "USD" }),
  timeoutSeconds: env.integer("FIXTURE_TIMEOUT", { default: 30 }),
  debug: env.flag("FIXTURE_DEBUG", { default: false }),
};
