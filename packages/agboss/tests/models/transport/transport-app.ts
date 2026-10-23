import type { App } from "../../../src/app/types.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { buildApplication } from "../../../src/application/create-app.js";
import type { Class, Token } from "../../../src/components/injection.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import type { ProviderFetch } from "../../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { SequentialIdGenerator } from "../../../src/testing/id-generator.js";
import { seconds } from "../../../src/units/index.js";
import { BedrockSdkClient } from "./bedrock-provider.fixture.js";

/** What a transport test's instance runs on: the scripted SDK client, the clock, an HTTP stub. */
export interface TransportAppParts {
  readonly client: BedrockSdkClient;
  readonly clock?: VirtualClock;
  readonly send?: ProviderFetch;
  /** Every instance the application's container creates, in order. */
  readonly created?: unknown[];
}

/**
 * One instance of an application with the production model gateway (#385: its transport
 * providers' `complete()` over the scripted client) — the container's own, not `testWith`'s scripts.
 */
export async function transportApp(application: Class, parts: TransportAppParts): Promise<App> {
  const assembled = await applicationOf(application, {});
  const overrides = new Map<Token, unknown>([[BedrockSdkClient, parts.client]]);
  const built = await buildApplication(
    assembled,
    {
      processEnv: {},
      ...(parts.send === undefined ? {} : { providerFetch: parts.send }),
      container: {
        overrides,
        onCreate: (instance) => {
          parts.created?.push(instance);
        },
      },
    },
    {
      instanceId: "instance-1",
      database: new InMemoryDatabase(),
      clock: parts.clock ?? new VirtualClock(),
      idGenerator: new SequentialIdGenerator(),
    },
  );
  return built.app;
}

/** A real macrotask: what a first execution loads lazily (its modules) gets to load. */
const realTick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Moves the test's clock a second at a time, a real tick between, until `done` settles — so a
 * call's backoff and timeout pass on the clock while the execution's own lazy loading takes real time.
 */
export async function advanceUntilSettled<T>(clock: VirtualClock, done: Promise<T>): Promise<T> {
  const progress = { settled: false };
  const settle = (): void => {
    progress.settled = true;
  };
  void done.then(settle, settle);
  for (let step = 0; step < 600 && !progress.settled; step++) {
    await realTick();
    await clock.advance(seconds(1));
  }
  return done;
}
