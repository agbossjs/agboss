import type { AnyTenantApp } from "../../src/app/types.js";
import {
  builtApplicationOf,
  type BuildApplicationOptions,
} from "../../src/application/create-app.js";
import { TEST_IDEMPOTENCY_KEYS } from "../../src/application/idempotency-key.js";
import type { Class } from "../../src/components/injection.js";

/**
 * An app on the internal build path with the test's idempotency keys but NOT the test PII key
 * (`createTestAppWith` gives both): what a `[pii.secret-required]` start check needs to see an
 * application whose secret is missing.
 */
export async function createAppWithoutPiiKey(
  application: Class,
  options: BuildApplicationOptions = {},
): Promise<AnyTenantApp> {
  const withTestKeys = { withoutIdempotencyKeys: true as const, ...options };
  const seams = { idempotencyTestKeys: TEST_IDEMPOTENCY_KEYS };
  return (await builtApplicationOf(application, withTestKeys, seams)).app;
}
