import { secret } from "../../../../../../agboss/src/index.js";
import type { StudioEnvironment } from "./app.environment.js";

export const environment: StudioEnvironment = {
  openRouterApiKey: secret("PROD_OPENROUTER_API_KEY"),
};
