import { builtApplicationOf, type BuildApplicationOptions } from "../application/create-app.js";
import { TEST_IDEMPOTENCY_KEYS } from "../application/idempotency-key.js";
import type { AnyTenantApp } from "../app/types.js";
import { TEST_PSEUDONYM_KEY } from "../pii/application-key.js";
import type { Class } from "../components/injection.js";

/**
 * An app instance on the internal build path for a test (#1317): `createAppWith` with the test's
 * idempotency keys and the PII key — an application with no `@DatabaseStorage`, or whose secret's variable is not set,
 * gets them, and a component that reaches `Idempotency` needs no secret declared. Refused when
 * `NODE_ENV` is `production`. Never a path of `createApp` or the CLI.
 */
export async function createTestAppWith(
  application: Class,
  options: BuildApplicationOptions = {},
): Promise<AnyTenantApp> {
  const withTestKeys = { withoutIdempotencyKeys: true as const, ...options };
  const seams = { idempotencyTestKeys: TEST_IDEMPOTENCY_KEYS, piiTestKey: TEST_PSEUDONYM_KEY };
  return (await builtApplicationOf(application, withTestKeys, seams)).app;
}
