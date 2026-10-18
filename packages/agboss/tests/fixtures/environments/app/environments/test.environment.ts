import { secret } from "../../../../../src/index.js";
import type { SettingsEnvironment } from "./app.environment.js";

export const environment: SettingsEnvironment = {
  apiUrl: "https://api.test.example.com",
  apiToken: secret("FIXTURE_API_TOKEN"),
  currency: "EUR",
  timeoutSeconds: 1,
  debug: true,
};
