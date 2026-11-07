import { env, secret } from "../../../../../src/index.js";
import type { RotationEnvironment } from "./app.environment.js";

export const environment: RotationEnvironment = {
  sqlitePath: env("ROTATION_SQLITE_PATH"),
  idempotencyKeyV1: secret("ROTATION_IDEMPOTENCY_KEY_V1"),
  idempotencyKeyV2: secret("ROTATION_IDEMPOTENCY_KEY_V2"),
  openRouterApiKey: secret("ROTATION_OPENROUTER_API_KEY"),
};
