import { describe, expect, it, vi } from "vitest";
import { recordUsage } from "../../src/finops/usage.js";
import {
  Backoff,
  ModelFailure,
  RateLimitPolicy,
  RetryPolicy,
  RetryPolicyError,
} from "../../src/models/index.js";
import { failureOfError, failureOfStatus, retryAfterOf } from "../../src/models/model-failure.js";
import { resilientFetch, type ResilienceOptions } from "../../src/models/resilient-fetch.js";
import { delayBefore } from "../../src/models/retry-policy.js";
import { minutes, seconds } from "../../src/units/index.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { ModelProviderDirectory } from "../../src/models/index.js";
import { ENV, instanceCalls, KEYS } from "./gateway.js";
import { advanceUntil, slowProvider } from "./slow-provider.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { InstantClock } from "./time.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";
import { completion, providerStub, type StubReply } from "./stub.js";

const exponential = RetryPolicy.exponential({
  maxAttempts: 3,
  initialDelay: seconds(1),
  maxDelay: seconds(20),
  jitter: false,
  retryOn: [ModelFailure.RateLimited, ModelFailure.ServerError, ModelFailure.Timeout],
});

/** A resilient client over a stub; `waits` collects every sleep. */
function client(
  replies: readonly StubReply[],
  retryPolicy = exponential,
  extra: Partial<ResilienceOptions> = {},
) {
  const stub = providerStub(replies);
  const clock = new InstantClock();
  const options: ResilienceOptions = {
    provider: "openrouter",
    timeout: seconds(5),
    retryPolicy,
    clock,
    random: () => 0.5,
    ...extra,
  };
  const send = resilientFetch(options, stub.fetch);
  return {
    send: () =>
      send("http://openrouter.test/api/v1/chat/completions", { method: "POST", body: "{}" }),
    stub,
    waits: clock.waits,
  };
}

describe("AC6: retry policies — only the listed failures, Retry-After honoured", () => {
  it("AC6: a listed failure is retried with a growing wait until it succeeds", async () => {
    const { send, stub, waits } = client([{ status: 500 }, { status: 503 }, completion()]);

    expect((await send()).status).toBe(200);
    expect(stub.requests).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it("AC6: a failure that is not listed is not retried", async () => {
    const onlyRateLimits = RetryPolicy.fixed({
      maxAttempts: 3,
      delay: seconds(1),
      retryOn: [ModelFailure.RateLimited],
    });
    const { send, stub } = client([{ status: 500 }, completion()], onlyRateLimits);

    expect((await send()).status).toBe(500);
    expect(stub.requests).toHaveLength(1);
  });

  it("AC6: a client error (400) is the replyWith, never retried", async () => {
    const { send, stub } = client([{ status: 400 }, completion()]);

    expect((await send()).status).toBe(400);
    expect(stub.requests).toHaveLength(1);
  });

  it("AC6: Retry-After is honoured when it is longer than the planned wait", async () => {
    const { send, waits } = client([
      { status: 429, headers: { "retry-after": "7" } },
      completion(),
    ]);

    expect((await send()).status).toBe(200);
    expect(waits).toEqual([7000]);
  });

  it("AC6: a Retry-After longer than maxDelay ends the retries with the provider's replyWith", async () => {
    const { send, stub, waits } = client([
      { status: 429, headers: { "retry-after": "60" } },
      completion(),
    ]);

    expect((await send()).status).toBe(429);
    expect(stub.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("AC6: RetryPolicy.none() tries once", async () => {
    const { send, stub } = client([{ status: 503 }, completion()], RetryPolicy.none());

    expect((await send()).status).toBe(503);
    expect(stub.requests).toHaveLength(1);
  });

  it("AC6: maxAttempts bounds the attempts", async () => {
    const { send, stub } = client([{ status: 503 }]);

    expect((await send()).status).toBe(503);
    expect(stub.requests).toHaveLength(3);
  });

  it("AC6: a network error and a timeout are failures too; the caller's own abort is never retried", async () => {
    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    const options: ResilienceOptions = {
      provider: "p",

      timeout: seconds(1),
      retryPolicy: RetryPolicy.fixed({
        maxAttempts: 2,
        delay: seconds(0),
        retryOn: [ModelFailure.NetworkError],
      }),
      clock: new InstantClock(),
    };
    const aborted = new AbortController();
    aborted.abort();

    await expect(resilientFetch(options, failing)("http://p.test/x")).rejects.toThrow(
      "fetch failed",
    );
    expect(failing).toHaveBeenCalledTimes(2);
    await expect(
      resilientFetch(options, failing)("http://p.test/x", { signal: aborted.signal }),
    ).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it("AC6: retries are one call — one replyWith, one usage record, paid once", async () => {
    const stub = providerStub([{ status: 502 }, { status: 502 }, completion("ok", 0.002)]);
    const gateway = createProviderGateway(ModelProviderDirectory.of([TestOpenRouterProvider]), {
      env: ENV,
      environment: KEYS,
      calls: instanceCalls(),
      send: stub.fetch,
      clock: new InstantClock(),
    });
    const settings = { model: "moonshotai/kimi-k2.6", temperature: 0, maxTokens: 10 };

    const replyWith = await gateway
      .chatModel({ user: { kind: "agent", agent: "scout" }, settings })
      .invoke("hi");

    expect(stub.requests).toHaveLength(3);
    expect(recordUsage("scout", settings, replyWith)).toMatchObject({
      costUsd: 0.002,
      costSource: "api",
    });
  });
});

describe("AC6: failures, waits and policies", () => {
  it("AC6: statuses and errors map to failures; Retry-After reads seconds and dates", () => {
    const timeout = new Error("t");
    timeout.name = "TimeoutError";

    expect([429, 408, 500, 503, 404, 200].map(failureOfStatus)).toEqual([
      ModelFailure.RateLimited,
      ModelFailure.Timeout,
      ModelFailure.ServerError,
      ModelFailure.ServerError,
      undefined,
      undefined,
    ]);
    expect(failureOfError(timeout)).toBe(ModelFailure.Timeout);
    expect(failureOfError("x")).toBe(ModelFailure.NetworkError);
    const at = (value: string) =>
      retryAfterOf(new Response(null, { headers: { "retry-after": value } }), 0);
    expect([at("2"), at(new Date(5000).toUTCString()), at("soon"), at(" ")]).toEqual([
      2000,
      5000,
      undefined,
      undefined,
    ]);
  });

  it("AC6: exponential waits double up to maxDelay, with jitter in the upper half", () => {
    const jittered = RetryPolicy.exponential({ ...exponential, jitter: true } as never);

    expect([1, 2, 3, 6].map((n) => delayBefore(exponential, n, () => 0))).toEqual([
      1000, 2000, 4000, 20000,
    ]);
    expect(delayBefore(jittered, 1, () => 0)).toBe(500);
    expect(delayBefore(RetryPolicy.none(), 1, () => 0)).toBe(0);
    expect(exponential.backoff).toBe(Backoff.Exponential);
  });

  it("AC6: a policy with no attempts or an upside-down delay is refused", () => {
    expect(() => RetryPolicy.fixed({ maxAttempts: 0, delay: seconds(1), retryOn: [] })).toThrow(
      RetryPolicyError,
    );
    expect(() =>
      RetryPolicy.exponential({
        maxAttempts: 2,
        initialDelay: seconds(5),
        maxDelay: seconds(1),
        jitter: false,
        retryOn: [],
      }),
    ).toThrow(RetryPolicyError);
  });
});

describe("#266 AC6: backoff is the retry policy's, and a sleeping retry holds no slot", () => {
  it("backoff with jitter, Retry-After, no slot while sleeping", async () => {
    const clock = new VirtualClock();
    const provider = slowProvider(clock, { replies: [{ status: 500 }, completion()] });
    const gate = instanceCalls(clock).gateOf(
      "p-model-provider",
      RateLimitPolicy.of({ maxConcurrentCalls: 1 }),
    );
    const send = resilientFetch(
      {
        provider: "p-model-provider",

        timeout: seconds(30),
        retryPolicy: RetryPolicy.exponential({
          maxAttempts: 3,
          initialDelay: seconds(1),
          maxDelay: seconds(20),
          jitter: true,
          retryOn: [ModelFailure.ServerError],
        }),
        ...(gate === undefined ? {} : { gate }),
        clock,
        random: () => 0.5,
      },
      provider.fetch,
    );
    const call = () =>
      send("http://p.test/chat/completions", { method: "POST", body: "{}" }).then((response) =>
        response.text(),
      );

    // the first call fails at 1 s and sleeps 750 ms (1 s with jitter at 0.5): the second gets the
    // only slot meanwhile, so the retry waits for it — sleeping held no slot
    await advanceUntil(clock, Promise.all([call(), call()]), seconds(0.25), 40);

    const zero = new VirtualClock().now().getTime();
    expect(provider.stats().started.map((at) => (at - zero) / 1000)).toEqual([0, 1, 2]);
  });
});
