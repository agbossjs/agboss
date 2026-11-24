import { builtApplicationOf, type BuildApplicationOptions } from "../application/create-app.js";
import { TEST_IDEMPOTENCY_KEYS } from "../application/idempotency-key.js";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";

/**
 * An app instance on the internal build path for a test (#1317): `createAppWith` with the test's
 * idempotency keys — an application with no `@DatabaseStorage`, or whose secret's variable is not set,
 * gets them, and a component that reaches `Idempotency` needs no secret declared. Refused when
 * `NODE_ENV` is `production`. Never a path of `createApp` or the CLI.
 */
export async function createTestAppWith(
  application: Class,
  options: BuildApplicationOptions = {},
): Promise<App> {
  const withTestKeys = { withoutIdempotencyKeys: true as const, ...options };
  const seams = { idempotencyTestKeys: TEST_IDEMPOTENCY_KEYS };
  return (await builtApplicationOf(application, withTestKeys, seams)).app;
}
