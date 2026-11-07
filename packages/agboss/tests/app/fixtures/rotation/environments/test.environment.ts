import { secret } from "../../../../../src/index.js";
import type { RotationEnvironment } from "./app.environment.js";

export const environment: RotationEnvironment = {
  sqlitePath: ":memory:",
  // unset in a test: testWith gives it the test key (#825)
  idempotencyKeyV1: secret("ROTATION_IDEMPOTENCY_KEY_V1"),
};
