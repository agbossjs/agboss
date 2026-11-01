import type { App } from "../../../src/app/types.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { buildApplication } from "../../../src/application/create-app.js";
import type { Class, Token } from "../../../src/components/injection.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import type { ProviderFetch } from "../../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { SequentialIdGenerator } from "../../../src/testing/id-generator.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { answer, BedrockSdkClient, ScriptedBedrockClient } from "./bedrock-provider.fixture.js";

/** What a transport test's instance runs on: the scripted SDK client, the clock, an HTTP stub. */
export interface TransportAppParts {
  readonly client: BedrockSdkClient;
  readonly clock?: VirtualClock;
  readonly send?: ProviderFetch;
  /** Every instance the application's container creates, in order. */
  readonly created?: unknown[];
  /** More instances in place of the application's classes. */
  readonly overrides?: ReadonlyMap<Token, unknown>;
}

/**
 * One instance of an application with the production model gateway (#385: its transport
 * providers' `complete()` over the scripted client) — the container's own, not `testWith`'s scripts.
 */
export async function transportApp(application: Class, parts: TransportAppParts): Promise<App> {
  const assembled = await applicationOf(application, {});
  const overrides = new Map<Token, unknown>([
    [BedrockSdkClient, parts.client],
    ...(parts.overrides ?? []),
  ]);
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

/** A real macrotask: the work a woken sleep scheduled gets to run before the next second. */
const realTick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** How far `advanceUntilSettled` moves the clock before it gives up. */
const MOST_SECONDS = 600;

/**
 * Moves the test's clock a second at a time, a real tick between, until `done` settles — so a
 * call's backoff and timeout pass on the clock. The clock moves with every real tick, so the work
 * must do no real I/O meanwhile: a first execution's modules, loaded lazily, are real I/O, and the
 * clock runs on while they load (#604) — warm them first (`warmedUp`). Fails after `MOST_SECONDS`
 * on the clock instead of leaving a wait no one will wake.
 */
export async function advanceUntilSettled<T>(clock: VirtualClock, done: Promise<T>): Promise<T> {
  const progress = { settled: false };
  const settle = (): void => {
    progress.settled = true;
  };
  void done.then(settle, settle);
  for (let step = 0; step < MOST_SECONDS && !progress.settled; step++) {
    await realTick();
    await clock.advance(seconds(1));
  }
  if (!progress.settled)
    throw new Error(`not settled after ${String(MOST_SECONDS)} s on the test's clock`);
  return done;
}

/**
 * Runs one execution of `application` to its end, answered at once, without moving any clock
 * (#604): every module a first execution loads lazily — its pass, its lease's events, its end — is
 * loaded then, so the clocked tests after it do no real I/O while `advanceUntilSettled` moves
 * their clock. Under load such a load outlasted the 600 ticks and the retry's backoff was never woken.
 */
export async function warmedUp(application: Class, start: Class): Promise<void> {
  const client = new ScriptedBedrockClient([answer("warm")]);
  const app = await transportApp(application, { client });
  await execute(app, start, { text: "warm" });
  await app.close();
}
