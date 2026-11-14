import { env, secret } from "../../../../../../agboss/src/index.js";
import type { StreamEnvironment } from "./app.environment.js";

export const environment: StreamEnvironment = {
  openRouterApiKey: secret("OPENROUTER_API_KEY"),
  openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL"),
};
