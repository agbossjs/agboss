import { describe, expect, it } from "vitest";
import { createJevClient } from "../../src/llm/jev-client.js";
import { ModelFailure, OpenRouterModelProvider, RetryPolicy } from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { milliseconds } from "../models/time.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes } from "../../src/units/index.js";

/** Whether a promise has settled yet, without letting its rejection go unhandled. */
const settledFlag = (promise: Promise<unknown>): { readonly isSettled: () => boolean } => {
  let isSettled = false;
  const settle = (): void => {
    isSettled = true;
  };
  promise.then(settle, settle);
  return { isSettled: () => isSettled };
};

/** A fetch that never answers until its signal aborts. */
const neverAnswers: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal?.reason as Error);
    });
  });

describe("model calls: the provider's timeout and retries (#95, now on the provider #151)", () => {
  it("AC1: a request that gets no replyWith fails at the provider's timeout on its clock instead of hanging", async () => {
    const clock = new VirtualClock();
    const send = resilientFetch(
      { provider: "p", timeout: milliseconds(50), retryPolicy: RetryPolicy.none(), clock },
      neverAnswers,
    );

    const sent = send("http://p.test/chat/completions");
    const outcome = settledFlag(sent);
    await clock.advance(milliseconds(49));
    expect(outcome.isSettled()).toBe(false);
    await clock.advance(milliseconds(1));

    await expect(sent).rejects.toThrow(/timeout/iu);
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
  it("AC4: a decision that gets no replyWith fails at its timeout on the clock (the router then falls back as for any failure)", async () => {
    const clock = new VirtualClock();
    const jev = createJevClient(
      { apiKey: "k", baseUrl: "https://example.test/api/v1" },
      neverAnswers,
      milliseconds(50),
      clock,
    );

    const decided = jev({ model: "typesafe/jev", input: "x", options: [] } as never);
    const outcome = settledFlag(decided);
    await clock.advance(milliseconds(49));
    expect(outcome.isSettled()).toBe(false);
    await clock.advance(milliseconds(1));

    await expect(decided).rejects.toThrow(/timeout/iu);
  });
});
