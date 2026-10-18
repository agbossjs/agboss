import { secret } from "../../../../../src/index.js";
import type { SettingsEnvironment } from "../../app/environments/app.environment.js";

export const environment: SettingsEnvironment = {
  apiUrl: "https://api.dev.example.com",
  apiToken: secret("FIXTURE_API_TOKEN"),
  currency: "USD",
  timeoutSeconds: 30,
  debug: false,
};
