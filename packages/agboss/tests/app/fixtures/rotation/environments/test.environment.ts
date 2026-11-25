import type { RotationEnvironment } from "./app.environment.js";

// no storage keys here: testWith gives an application with no storage the test's idempotency keys (#825)
export const environment: RotationEnvironment = {};
