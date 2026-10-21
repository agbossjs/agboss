import { secret } from "../../../../../../agboss/src/index.js";
import type { StudioEnvironment } from "./app.environment.js";

export const environment: StudioEnvironment = { openRouterApiKey: secret("OPENROUTER_API_KEY") };
