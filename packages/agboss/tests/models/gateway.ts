import type { BuildOptions } from "../../src/app/app-deps.js";
import type { App } from "../../src/app/types.js";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import type { Class } from "../../src/components/injection.js";
import type { ResolvedModelSettings } from "../../src/config/types.js";
import { resolveEnvironment } from "../../src/environments/resolve.js";
import { secret } from "../../src/environments/secret.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import type { Clock } from "../../src/infrastructure/clock.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryRateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { ProviderCalls } from "../../src/models/calls/provider-calls.js";
import { ModelProviderDirectory } from "../../src/models/index.js";
import type { ModelProviderType } from "../../src/models/model-provider.decorator.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { completion, providerStub, type StubReply } from "./stub.js";

/** The process environment of the provider tests: base URLs come from it, keys never do. */
export const ENV = {};

/** The application's environment with the providers' keys, resolved as at a start (#266 S73 c). */
export const KEYS = resolveEnvironment(
  {
    name: "test",
    contract: "ProviderTestEnvironment",
    values: { openRouterApiKey: secret("OPENROUTER_API_KEY"), backupApiKey: secret("BACKUP_KEY") },
  },
  { OPENROUTER_API_KEY: "k", BACKUP_KEY: "backup-key" },
);

/**
 * The shared calls of one application instance (rate limits, 429 pauses, breakers) over the
 * in-memory `RateLimitRepository` — two instances of one test share `database`.
 */
export function instanceCalls(
  clock: Clock = new VirtualClock(),
  database: InMemoryDatabase = new InMemoryDatabase(),
  instanceId = "instance-1",
): ProviderCalls {
  const application = applicationContextOf({
    name: "provider-test-application",
    version: "1.0.0",
    instanceId,
    startedAt: clock.now(),
    environmentName: "test",
    environment: KEYS,
  });
  return new ProviderCalls(new InMemoryRateLimitRepository(clock, application, database), clock);
}

/** The bodies a provider gateway sends for one chat call per settings. */
export async function wireBodies(
  providers: readonly ModelProviderType[],
  calls: readonly ResolvedModelSettings[],
  replies: readonly StubReply[] = [completion()],
): Promise<Record<string, unknown>[]> {
  const stub = providerStub(replies);
  const gateway = createProviderGateway(ModelProviderDirectory.of(providers), {
    env: ENV,
    environment: KEYS,
    calls: instanceCalls(),
    send: stub.fetch,
  });
  for (const settings of calls) {
    await gateway.chatModel({ user: { kind: "agent", agent: "scout" }, settings }).invoke("hi");
  }
  return stub.requests.map((request) => request.body ?? {});
}

/**
 * An app of `application` whose environment holds the providers' keys (`KEYS`) — as `createApp`
 * builds it from an environment file that sets them; for tests of the providers' HTTP side.
 */
export async function appWithKeys(application: Class, options: BuildOptions = {}): Promise<App> {
  const built = await buildApplication(await applicationOf(application, {}), {
    environment: KEYS,
    ...options,
  });
  return built.app;
}
