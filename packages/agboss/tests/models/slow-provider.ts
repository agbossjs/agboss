import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication, type BuiltApplication } from "../../src/application/create-app.js";
import type { Class } from "../../src/components/injection.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import type { ProviderFetch } from "../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { SequentialIdGenerator } from "../../src/testing/id-generator.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { completion, type StubReply } from "./stub.js";

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** What a slow provider saw: calls in flight now, the most at once, every start and answer. */
export interface SlowProviderStats {
  readonly inFlight: number;
  readonly most: number;
  /** The clock's milliseconds of each call's start, in order. */
  readonly started: readonly number[];
  /** Calls answered so far. */
  readonly answered: number;
}

/**
 * A provider's HTTP side that takes `takes` on the test's clock per call — so calls overlap and a
 * test can count them in flight. `GET …/models` lists `models`; every other request gets the next
 * reply (the last repeats). A call's own signal ends it.
 */
export function slowProvider(
  clock: VirtualClock,
  options: {
    readonly takes?: Milliseconds;
    readonly replies?: readonly StubReply[];
    readonly models?: readonly string[];
  } = {},
): { readonly fetch: ProviderFetch; readonly stats: () => SlowProviderStats } {
  const { takes = seconds(1), replies = [completion()], models = [] } = options;
  let inFlight = 0;
  let most = 0;
  let answered = 0;
  let next = 0;
  const started: number[] = [];
  const fetchStub: ProviderFetch = async (input, init) => {
    if (urlOf(input).endsWith("/models"))
      return Response.json({ data: models.map((id) => ({ id })) });
    inFlight += 1;
    most = Math.max(most, inFlight);
    started.push(clock.now().getTime());
    const reply = replies[Math.min(next, replies.length - 1)] ?? completion();
    next += 1;
    try {
      await clock.sleep(takes, init?.signal ?? undefined);
      init?.signal?.throwIfAborted();
      answered += 1;
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    } finally {
      inFlight -= 1;
    }
  };
  return {
    fetch: fetchStub,
    stats: () => ({ inFlight, most, started: [...started], answered }),
  };
}

/** Moves the clock in steps until `done` settles (at most `steps` of `step`). */
export async function advanceUntil<T>(
  clock: VirtualClock,
  done: Promise<T>,
  step: Milliseconds = seconds(1),
  steps = 120,
): Promise<T> {
  const progress = { settled: false };
  const settle = (): void => {
    progress.settled = true;
  };
  void done.then(settle, settle);
  for (let count = 0; count < steps && !progress.settled; count++) await clock.advance(step);
  return done;
}

/**
 * Instances of one application over one set of in-memory stores and one clock — what `testWith(App,
 * { instances })` builds — with the real model providers over `providerFetch` (`testWith` scripts
 * the models above the providers, so their rate limits are tested here).
 */
export async function instancesOf(
  application: Class,
  count: number,
  providerFetch: ProviderFetch,
  clock: VirtualClock,
): Promise<readonly BuiltApplication[]> {
  const assembled = await applicationOf(application, {});
  const database = new InMemoryDatabase();
  const built: BuiltApplication[] = [];
  // ids in the order executions start, as in testWith: `thread-1`, `thread-2`, … (#313)
  const idGenerator = new SequentialIdGenerator();
  for (let instance = 1; instance <= count; instance++) {
    built.push(
      await buildApplication(
        assembled,
        { processEnv: {}, providerFetch },
        { instanceId: `instance-${String(instance)}`, database, clock, idGenerator },
      ),
    );
  }
  return built;
}
