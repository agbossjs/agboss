/**
 * #266 AC5: on a 429 the provider's whole queue pauses for `Retry-After` (else the retry policy's
 * delay) — on every instance, the pause being in `RateLimitRepository` (S58) — then this
 * instance's `maxConcurrentCalls` halves and grows back by one a minute without a 429 (AIMD).
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { concurrencyAt, halvedAt } from "../../src/models/calls/concurrency-level.js";
import { ModelFailure, RateLimitPolicy, RetryPolicy } from "../../src/models/index.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";
import { advanceUntil, slowProvider } from "./slow-provider.js";
import { completion, type StubReply } from "./stub.js";

const POLICY = RateLimitPolicy.of({ maxConcurrentCalls: 4 });
const RETRIES = RetryPolicy.exponential({
  maxAttempts: 3,
  initialDelay: seconds(1),
  maxDelay: seconds(20),
  jitter: false,
  retryOn: [ModelFailure.RateLimited],
});
const TOO_MANY = (retryAfter?: string): StubReply => ({
  status: 429,
  ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
});

/** One instance's client of a provider and its gate, over a provider that takes 1 s a call. */
function instance(
  clock: VirtualClock,
  replies: readonly StubReply[],
  database = new InMemoryDatabase(),
  instanceId = "instance-1",
) {
  const provider = slowProvider(clock, { replies });
  const gate = instanceCalls(clock, database, instanceId).gateOf("p-model-provider", POLICY);
  if (gate === undefined) throw new Error("a policy makes a gate");
  const client = resilientFetch(
    {
      provider: "p-model-provider",
      baseUrl: "http://p.test",
      timeout: seconds(30),
      retryPolicy: RETRIES,
      gate,
      clock,
    },
    provider.fetch,
  );
  const call = () =>
    client("http://p.test/chat/completions", { method: "POST", body: "{}" }).then(
      async (response) => {
        await response.text();
        return response.status;
      },
    );
  return { call, gate, provider };
}

/** Seconds since the test's start of each request the provider got. */
const startsOf = (started: readonly number[]): number[] => {
  const zero = new VirtualClock().now().getTime();
  return started.map((at) => (at - zero) / 1000);
};

describe("#266 AC5: a 429 slows the whole provider down", () => {
  it("whole queue pauses for Retry-After, AIMD back up", async () => {
    const clock = new VirtualClock();
    const { call, gate, provider } = instance(clock, [TOO_MANY("10"), completion()]);
    const first = call();
    await clock.advance(seconds(1)); // the 429 comes at 1 s: paused until 11 s
    await clock.advance(seconds(1));
    const others = [call(), call(), call()];

    await clock.advance(seconds(8));
    expect(startsOf(provider.stats().started)).toEqual([0]);
    expect(gate.allowedNow()).toBe(2);
    const statuses = await advanceUntil(clock, Promise.all([first, ...others]));

    expect(statuses).toEqual([200, 200, 200, 200]);
    // at 11 s the pause ends and two calls go (4 halved); the next two when those end
    expect(startsOf(provider.stats().started)).toEqual([0, 11, 11, 12, 12]);
    await clock.advance(minutes(1));
    expect(gate.allowedNow()).toBe(3);
    await clock.advance(minutes(1));
    expect(gate.allowedNow()).toBe(4);
    await clock.advance(minutes(5));
    expect(gate.allowedNow()).toBe(4);
  });

  it("without Retry-After the queue pauses for the retry policy's delay", async () => {
    const clock = new VirtualClock();
    const { call, provider } = instance(clock, [TOO_MANY(), completion()]);
    const first = call();
    await clock.advance(seconds(1));
    const second = call();

    await advanceUntil(clock, Promise.all([first, second]));

    // the 429 at 1 s pauses everyone for the first retry's delay (1 s): both go again at 2 s
    expect(startsOf(provider.stats().started)).toEqual([0, 2, 2]);
  });

  it("two instances, one seeing a 429: the pause holds on the other one too", async () => {
    const clock = new VirtualClock();
    const database = new InMemoryDatabase();
    const seeing = instance(clock, [TOO_MANY("30"), completion()], database, "instance-1");
    const other = instance(clock, [completion()], database, "instance-2");
    const first = seeing.call();
    await clock.advance(seconds(1)); // the 429 comes at 1 s: paused until 31 s
    await clock.advance(seconds(1));

    const elsewhere = other.call();
    await advanceUntil(clock, Promise.all([first, elsewhere]));

    expect(startsOf(other.provider.stats().started)).toEqual([31]);
    // AIMD is per instance: only the instance that saw the 429 lowered its level
    expect([seeing.gate.allowedNow(), other.gate.allowedNow()]).toEqual([2, 4]);
  });

  it("a 429 during a backoff extends the pause, a shorter one never shortens it; one halving per pause", async () => {
    const clock = new VirtualClock();
    const { call, provider } = instance(clock, [TOO_MANY("5"), TOO_MANY("20"), completion()]);
    const first = call();
    const second = call();
    await clock.advance(seconds(1)); // both answered 429: 5 s, then 20 s — paused until 21 s

    const third = call();
    await advanceUntil(clock, Promise.all([first, second, third]));

    // at 21 s two calls go (4 halved once, not twice): the waiting one and the first retry
    expect(startsOf(provider.stats().started)).toEqual([0, 0, 21, 21, 22]);
  });

  it("the AIMD steps: halve on a 429 (at least one call), plus one a minute up to the cap", () => {
    const level = halvedAt(5, undefined, 0);

    expect(level).toEqual({ lowered: 2, since: 0 });
    expect(
      [0, 59_999, 60_000, 180_000, 600_000].map((now) => concurrencyAt(5, level, now)),
    ).toEqual([2, 2, 3, 5, 5]);
    expect(halvedAt(1, undefined, 0).lowered).toBe(1);
    expect(halvedAt(8, halvedAt(8, undefined, 0), 0).lowered).toBe(2);
    expect(concurrencyAt(4, undefined, 0)).toBe(4);
  });
});
