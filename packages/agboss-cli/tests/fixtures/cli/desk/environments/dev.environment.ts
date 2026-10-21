import { secret } from "../../../../../../agboss/src/index.js";
import type { DeskEnvironment } from "./app.environment.js";

export const environment: DeskEnvironment = { openRouterApiKey: secret("OPENROUTER_API_KEY") };
