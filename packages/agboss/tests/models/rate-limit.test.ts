/**
 * #266 AC3, AC4, AC7: `rateLimitPolicy` is one limit per provider, shared by every execution,
 * tenant and application instance through `RateLimitRepository`; a call without room waits — its
 * signal ends the wait, its timeout starts only with the room; without a policy there is no limit.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import {
  ModelFailure,
  RateLimitPolicy,
  RateLimitPolicyError,
  RetryPolicy,
} from "../../src/models/index.js";
import { resilientFetch, type ResilienceOptions } from "../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { execute } from "../helpers/flow.js";
import { LimitedApplication, LimitedModelProvider } from "./fixtures/limited.workflow.js";
import { instanceCalls, KEYS } from "./gateway.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { ModelProviderDirectory } from "../../src/models/index.js";
import { advanceUntil, instancesOf, slowProvider } from "./slow-provider.js";
import { completion } from "./stub.js";

const URL = "http://limited.test/v1/chat/completions";
const LIMITED = { models: ["limited/model"], replies: [completion("done")] };

/** A provider client of one instance under `rateLimitPolicy` (none = no limit). */
function clientOf(
  send: typeof fetch,
  clock: VirtualClock,
  options: { readonly policy?: RateLimitPolicy; readonly database?: InMemoryDatabase } = {},
  extra: Partial<ResilienceOptions> = {},
  instanceId = "instance-1",
) {
  const calls = instanceCalls(clock, options.database ?? new InMemoryDatabase(), instanceId);
  const gate = calls.gateOf("limited-model-provider", options.policy);
  const client = resilientFetch(
    {
      provider: "limited-model-provider",
      baseUrl: "http://limited.test/v1",
      timeout: seconds(30),
      retryPolicy: RetryPolicy.none(),
      ...(gate === undefined ? {} : { gate }),
      clock,
      ...extra,
    },
    send,
  );
  // reading the answer to its end releases the room it held
  return (signal?: AbortSignal) =>
    client(URL, { method: "POST", body: "{}", ...(signal === undefined ? {} : { signal }) }).then(
      async (response) => ({ status: response.status, text: await response.text() }),
    );
}

describe("#266 AC3: one limit per provider for the whole application", () => {
  it("maxConcurrentCalls 2 across two executions and two instances", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { ...LIMITED, takes: seconds(5) });
    const [first, second] = await instancesOf(LimitedApplication, 2, provider.fetch, clock);
    if (first === undefined || second === undefined) throw new Error("two instances");

    const runs = Promise.all([
      execute(first.app, ChatStart, { text: "a" }, { tenant: { tenantId: "acme" } }),
      execute(first.app, ChatStart, { text: "b" }, { tenant: { tenantId: "acme" } }),
      execute(first.app, ChatStart, { text: "c" }, { tenant: { tenantId: "globex" } }),
      execute(second.app, ChatStart, { text: "d" }, { tenant: { tenantId: "acme" } }),
      execute(second.app, ChatStart, { text: "e" }, { tenant: { tenantId: "initech" } }),
    ]);
    const results = await advanceUntil(clock, runs);

    expect(results.map((result) => result.output)).toEqual(
      Array.from({ length: 5 }, () => ({ text: "done" })),
    );
    expect(provider.stats()).toMatchObject({ most: 2, inFlight: 0, answered: 5 });
    await Promise.all([first.app.close(), second.app.close()]);
  });

  it("parallel calls of one instance share the limit; a release lets the next one in at once", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { takes: seconds(5) });
    const call = clientOf(provider.fetch, clock, {
      policy: RateLimitPolicy.of({ maxConcurrentCalls: 2 }),
    });

    const all = Promise.all([call(), call(), call(), call(), call()]);
    await advanceUntil(clock, all);

    const start = new VirtualClock().now().getTime();
    expect(provider.stats().most).toBe(2);
    expect(provider.stats().started.map((at) => (at - start) / 1000)).toEqual([0, 0, 5, 5, 10]);
  });

  it("perMinute.calls: calls are counted when they start, the rest wait for the window", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { takes: seconds(1) });
    const call = clientOf(provider.fetch, clock, {
      policy: RateLimitPolicy.of({ perMinute: { calls: 2 } }),
    });

    const all = Promise.all([call(), call(), call()]);
    await advanceUntil(clock, all, seconds(10));

    const start = new VirtualClock().now().getTime();
    expect(provider.stats().started.map((at) => (at - start) / 1000)).toEqual([0, 0, 60]);
  });

  it("perMinute.tokens: a call starts only while the window's tokens are below the limit — calls in flight may overshoot", async () => {
    const clock = new VirtualClock();
    // each answer reports 15 tokens; the limit is 20: two calls in flight overshoot to 30
    const provider = slowProvider(clock, { takes: seconds(1) });
    const call = clientOf(provider.fetch, clock, {
      policy: RateLimitPolicy.of({ perMinute: { tokens: 20 } }),
    });
    const counted = Promise.all([call(), call()]).then(() => clock.now().getTime());
    const countedAt = await advanceUntil(clock, counted);
    await clock.advance(seconds(1));

    // the clock moves a poll at a time: a start is seen at the moment it happens
    await advanceUntil(clock, call(), seconds(0.25), 400);

    const [first, second, third] = provider.stats().started;
    // both started on an empty window; the third waits until their 30 tokens leave it
    expect(first).toBe(second);
    expect((third ?? 0) - countedAt).toBe(60_000);
  });

  it("a policy needs a limit, each a whole number ≥ 1", () => {
    expect(() => RateLimitPolicy.of({})).toThrow(RateLimitPolicyError);
    expect(() => RateLimitPolicy.of({ maxConcurrentCalls: 0 })).toThrow(
      "maxConcurrentCalls must be an integer ≥ 1, got 0",
    );
    expect(() => RateLimitPolicy.of({ perMinute: { tokens: 1.5 } })).toThrow(RateLimitPolicyError);
    expect(RateLimitPolicy.of({ perMinute: { calls: 500 } })).toMatchObject({
      maxConcurrentCalls: undefined,
      balancing: "tenant-round-robin",
    });
  });
});

describe("#266 AC4: a call without room waits", () => {
  it("waits, cancel ends the wait, timeout starts after the slot", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { ...LIMITED, takes: seconds(20) });
    const [instance] = await instancesOf(LimitedApplication, 1, provider.fetch, clock);
    if (instance === undefined) throw new Error("one instance");
    const { app } = instance;
    // two calls hold both slots for 20 s; the provider's timeout is 30 s
    const holders = Promise.all([
      execute(app, ChatStart, { text: "a" }),
      execute(app, ChatStart, { text: "b" }),
    ]);
    const waiting = execute(app, ChatStart, { text: "c" });
    const cancelled = execute(app, ChatStart, { text: "d" });
    cancelled.catch(() => undefined);
    const aborted = new AbortController();
    const signalled = execute(app, ChatStart, { text: "e" }, { signal: aborted.signal });
    signalled.catch(() => undefined);

    await clock.advance(seconds(1));
    expect(await app.cancel("thread-4")).toEqual({ cancelled: true });
    aborted.abort(new Error("the caller left"));
    await expect(cancelled).rejects.toBeInstanceOf(ExecutionCancelledError);
    await expect(signalled).rejects.toThrow();
    // the waiting call got its slot after 20 s and took 20 s more: 40 s since it asked, no timeout
    const [held, waited] = await advanceUntil(clock, Promise.all([holders, waiting]));

    expect(held.map((result) => result.threadId)).toEqual(["thread-1", "thread-2"]);
    expect(waited).toMatchObject({ threadId: "thread-3", output: { text: "done" } });
    expect(provider.stats()).toMatchObject({ most: 2, answered: 3 });
    await app.close();
  });

  it("the signal of a waiting call ends its wait with its reason; the call never reaches the provider", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { takes: seconds(10) });
    const call = clientOf(provider.fetch, clock, {
      policy: RateLimitPolicy.of({ maxConcurrentCalls: 1 }),
    });
    const holder = call();
    const controller = new AbortController();
    const waiter = call(controller.signal);
    waiter.catch(() => undefined);
    await clock.advance(seconds(1));

    controller.abort(new Error("stopped by the caller"));

    await expect(waiter).rejects.toThrow("stopped by the caller");
    await advanceUntil(clock, holder);
    expect(provider.stats().started).toHaveLength(1);
  });

  it("a signal already aborted never waits", async () => {
    const clock = new VirtualClock();
    const call = clientOf(slowProvider(clock).fetch, clock, {
      policy: RateLimitPolicy.of({ maxConcurrentCalls: 1 }),
    });

    await expect(call(AbortSignal.abort(new Error("already")))).rejects.toThrow("already");
  });
});

describe("#266 AC7: without rateLimitPolicy there is no limit", () => {
  it("no policy → no limit", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { takes: seconds(5) });
    const call = clientOf(provider.fetch, clock);

    await advanceUntil(clock, Promise.all([call(), call(), call(), call(), call()]));

    expect(provider.stats().most).toBe(5);
  });

  it("a 429 without a policy pauses nobody else: only the call itself backs off", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, {
      takes: seconds(1),
      replies: [{ status: 429, headers: { "retry-after": "30" } }, completion()],
    });
    const retrying = RetryPolicy.fixed({
      maxAttempts: 2,
      delay: seconds(1),
      retryOn: [ModelFailure.RateLimited],
    });
    const call = clientOf(provider.fetch, clock, {}, { retryPolicy: retrying });

    const first = call();
    await clock.advance(seconds(2));
    const second = call();
    await advanceUntil(clock, Promise.all([first, second]));

    const start = new VirtualClock().now().getTime();
    expect(provider.stats().started.map((at) => (at - start) / 1000)).toEqual([0, 2]);
  });
});

describe("#266 × #279: every model call goes through the provider's gate — arbiters too", () => {
  it("an arbiter's chat model shares the provider's maxConcurrentCalls with every other caller", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { ...LIMITED, takes: seconds(5) });
    const gateway = createProviderGateway(ModelProviderDirectory.of([LimitedModelProvider]), {
      env: {},
      environment: KEYS,
      calls: instanceCalls(clock),
      send: provider.fetch,
      clock,
    });
    const settings = { model: "limited/model", temperature: 0, maxTokens: 10 };
    const arbiter = () =>
      gateway
        .chatModel({ user: { kind: "arbiter", arbiter: "quality-arbiter" }, settings })
        .invoke("hi");
    const agent = () =>
      gateway.chatModel({ user: { kind: "agent", agent: "limited-agent" }, settings }).invoke("hi");

    await advanceUntil(clock, Promise.all([arbiter(), arbiter(), agent()]));

    expect(provider.stats()).toMatchObject({ most: 2, answered: 3 });
  });
});
