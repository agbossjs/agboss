import { secret } from "../../../../../src/index.js";
import type { RotationEnvironment } from "./app.environment.js";

export const environment: RotationEnvironment = {
  openRouterApiKey: secret("ROTATION_OPENROUTER_API_KEY"),
};
