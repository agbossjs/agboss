import { describe, expect, it } from "vitest";
import { createJevClient } from "../../src/llm/jev-client.js";
import { ModelFailure, OpenRouterModelProvider, RetryPolicy } from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { milliseconds } from "../models/time.js";
import { minutes } from "../../src/units/index.js";

/** A fetch that never answers until its signal aborts. */
const neverAnswers: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason as Error);
    });
  });

describe("model calls: the provider's timeout and retries (#95, now on the provider #151)", () => {
  it("AC1: a request that gets no replyWith fails within the provider's timeout instead of hanging", async () => {
    const send = resilientFetch(
      {
        provider: "p",

        timeout: milliseconds(50),
        retryPolicy: RetryPolicy.none(),
      },
      neverAnswers,
    );
    const started = Date.now();

    await expect(send("http://p.test/chat/completions")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("AC2: a request that timed out is retried by the policy before giving up", async () => {
    let calls = 0;
    const counting: typeof fetch = (url, init) => {
      calls += 1;
      return neverAnswers(url, init);
    };
    const send = resilientFetch(
      {
        provider: "p",

        timeout: milliseconds(20),
        retryPolicy: RetryPolicy.fixed({
          maxAttempts: 3,
          delay: milliseconds(0),
          retryOn: [ModelFailure.Timeout],
        }),
      },
      counting,
    );

    await expect(send("http://p.test/chat/completions")).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("AC3: sensible defaults on the built-in provider: a 2-minute timeout, 3 attempts on transient failures", () => {
    const options = modelProviderOf(OpenRouterModelProvider);

    expect(options.timeout).toBe(minutes(2));
    expect(options.retryPolicy).toMatchObject({
      maxAttempts: 3,
      retryOn: [ModelFailure.Timeout, ModelFailure.RateLimited, ModelFailure.ServerError],
    });
  });
});

describe("Jev calls: the standard fetch abort signal (#95)", () => {
  it("AC4: a decision that gets no replyWith fails in time (the router then falls back as for any failure)", async () => {
    const jev = createJevClient(
      { apiKey: "k", baseUrl: "https://example.test/api/v1" },
      neverAnswers,
      milliseconds(50),
    );
    const started = Date.now();

    await expect(
      jev({ model: "typesafe/jev", input: "x", options: [] } as never),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
