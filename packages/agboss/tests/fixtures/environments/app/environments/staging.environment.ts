import { env, secret } from "../../../../../src/index.js";
import type { SettingsEnvironment } from "./app.environment.js";

export const environment: SettingsEnvironment = {
  apiUrl: "https://api.staging.example.com",
  apiToken: secret("FIXTURE_API_TOKEN"),
  currency: env("FIXTURE_CURRENCY"),
  timeoutSeconds: env.integer("FIXTURE_TIMEOUT"),
  debug: false,
};
