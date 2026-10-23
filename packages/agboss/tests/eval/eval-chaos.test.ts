/**
 * #396 PR 6 (S2 Q11) — chaos: failures injected into model calls at the provider's HTTP client and
 * a transport's `complete()`, seeded and reproducible; under the retry policy (a retried 429 still
 * answers), into `.onError` and its undo (#340) when nothing retries, on the real budgets.
 */
import { describe, expect, it } from "vitest";
import { ChaosFailure } from "../../src/eval/index.js";
import type { ChaosOptions } from "../../src/eval/chaos/chaos-failure.js";
import { chaosProblemOf } from "../../src/eval/chaos/chaos-failure.js";
import { ModelChaos, modelChaosOf } from "../../src/eval/chaos/model-chaos.js";
import { FinishReason } from "../../src/models/finish-reason.js";
import { ModelFailure, RetryPolicy } from "../../src/models/index.js";
import { failureOfError } from "../../src/models/model-failure.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { ModelProviderFailureError } from "../../src/models/transport/failure-error.js";
import type { ModelProviderResponse } from "../../src/models/transport/transport.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { nameOf } from "../../src/components/name-of.js";
import { CompensationReason } from "../../src/flow/compensation.js";
import { appWithKeys } from "../models/gateway.js";
import { completion, providerStub, toolCallCompletion } from "../models/stub.js";
import { InstantClock } from "../models/time.js";
import {
  ChaosWorkflowStart,
  ConfirmedWorkflowFinish,
  FragileChaosApplication,
  ReleaseAction,
  ReleasedWorkflowFinish,
  RetryingChaosApplication,
} from "./fixtures/chaos.workflow.js";

const URL = "http://chaos.test/v1/chat/completions";
const post = { method: "POST", body: "{}" } as const;

/** A random of fixed draws: below the rate injects, the next draw picks the failure. */
const draws = (...values: number[]): (() => number) => {
  const queue = [...values];
  return () => queue.shift() ?? 0.99;
};

const chaosOf = (failures: readonly ChaosFailure[], ...values: number[]): ModelChaos =>
  new ModelChaos({ rate: 0.5, seed: 1, failures }, draws(...values));

/** A seed whose first call fails with `failure` and whose second goes through. */
function seedFailingOnce(failure: ChaosFailure): ChaosOptions {
  for (let seed = 0; seed < 10_000; seed += 1) {
    const probe = new ModelChaos({ rate: 0.5, seed, failures: [failure] });
    if (probe.next() === failure && probe.next() === undefined)
      return { rate: 0.5, seed, failures: [failure] };
  }
  throw new Error("no seed");
}

describe("#396 PR 6: the chaos sequence", () => {
  it("one seed, one sequence; a rate of 1 fails every call", () => {
    const options = { rate: 0.3, seed: 7, failures: Object.values(ChaosFailure) };
    const first = new ModelChaos(options);
    const second = new ModelChaos(options);
    const sequence = (chaos: ModelChaos) => Array.from({ length: 50 }, () => chaos.next());

    expect(sequence(first)).toEqual(sequence(second));
    expect(sequence(first).some((failure) => failure !== undefined)).toBe(true);
    const always = new ModelChaos({ rate: 1, seed: 3, failures: [ChaosFailure.Timeout] });
    expect(Array.from({ length: 5 }, () => always.next())).toEqual(
      Array.from({ length: 5 }, () => ChaosFailure.Timeout),
    );
  });

  it("the rate, the seed and the failures are checked", () => {
    const failures = [ChaosFailure.Timeout];

    expect(chaosProblemOf({ rate: 0, seed: 1, failures })).toBe(
      "chaos rate: above 0 and at most 1, got 0",
    );
    expect(chaosProblemOf({ rate: 0.5, seed: 1.5, failures })).toBe(
      "chaos seed: a whole number, got 1.5",
    );
    expect(chaosProblemOf({ rate: 0.5, seed: 1, failures: [] })).toBe(
      "chaos failures: at least one",
    );
    expect(() => new ModelChaos({ rate: 2, seed: 1, failures })).toThrow(RangeError);
  });

  it("one injector per options object: every workflow built with them shares its counts", () => {
    const options: ChaosOptions = { rate: 0.5, seed: 1, failures: [ChaosFailure.Timeout] };

    expect(modelChaosOf(options)).toBe(modelChaosOf(options));
    expect(modelChaosOf({ ...options })).not.toBe(modelChaosOf(options));
  });
});

describe("#396 PR 6: at the provider's HTTP client", () => {
  it("a 429, a timeout and a truncated answer — model lists (GET) are never touched", async () => {
    const stub = providerStub([toolCallCompletion("answer-reservation-dto", { id: "seat-1" })]);
    const chaos = chaosOf(
      [ChaosFailure.RateLimited, ChaosFailure.Timeout, ChaosFailure.TruncatedResponse],
      ...[0.1, 0.1, 0.1, 0.5, 0.1, 0.9],
    );
    const send = chaos.fetchOf(stub.fetch);

    const models = await send("http://chaos.test/v1/models");
    const limited = await send(URL, post);
    const timedOut = send(URL, post);
    await expect(timedOut).rejects.toMatchObject({ name: "TimeoutError" });
    const truncated = (await (await send(URL, post)).json()) as {
      choices: {
        finish_reason: string;
        message: { tool_calls: { function: { arguments: string } }[] };
      }[];
    };

    expect(models.status).toBe(200);
    expect(limited.status).toBe(429);
    expect(failureOfError(await timedOut.catch((error: unknown) => error))).toBe(
      ModelFailure.Timeout,
    );
    expect(truncated.choices[0]?.finish_reason).toBe(FinishReason.Length);
    expect(truncated.choices[0]?.message.tool_calls[0]?.function.arguments).toBe('{"id":"');
    expect(chaos.summary()).toMatchObject({
      calls: 3,
      injected: { "rate-limited": 1, timeout: 1, "truncated-response": 1 },
    });
  });

  it("a retry policy retries an injected 429 like a provider's own", async () => {
    const stub = providerStub([completion("ok")]);
    const chaos = chaosOf([ChaosFailure.RateLimited], 0.1, 0.1, 0.9);
    const clock = new InstantClock();
    const send = resilientFetch(
      {
        provider: "retrying-model-provider",
        timeout: seconds(5),
        retryPolicy: RetryPolicy.fixed({
          maxAttempts: 2,
          delay: seconds(1),
          retryOn: [ModelFailure.RateLimited],
        }),
        clock,
      },
      chaos.fetchOf(stub.fetch),
    );

    const response = await send(URL, post);

    expect(response.status).toBe(200);
    expect(clock.waits).toHaveLength(1);
    expect(stub.requests).toHaveLength(1);
    expect(chaos.summary()).toMatchObject({ calls: 2, injected: { "rate-limited": 1 } });
  });
});

describe("#396 PR 6: at a transport's complete()", () => {
  const answer: ModelProviderResponse = {
    text: "confirmed",
    toolCalls: [{ id: "call-1", name: "lookup-tool", arguments: { orderId: "7", note: "x" } }],
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const complete = () => Promise.resolve(answer);
  const request = { model: "m", messages: [], tools: [] } as never;

  it("a 429 and a timeout are the transport's failures; a truncated answer is cut", async () => {
    const chaos = chaosOf(
      [ChaosFailure.RateLimited, ChaosFailure.Timeout, ChaosFailure.TruncatedResponse],
      ...[0.1, 0.1, 0.1, 0.5, 0.1, 0.9],
    );
    const call = chaos.completeOf(complete);

    await expect(call(request)).rejects.toMatchObject({ failure: ModelFailure.RateLimited });
    await expect(call(request)).rejects.toBeInstanceOf(ModelProviderFailureError);
    const truncated = await call(request);

    expect(truncated).toMatchObject({
      text: "conf",
      toolCalls: [{ arguments: { orderId: "7" } }],
      finishReason: FinishReason.Length,
    });
  });
});

describe("#396 PR 6: an application under chaos", () => {
  it("the provider's retry policy absorbs an injected 429: the run confirms", async () => {
    const stub = providerStub([completion("Confirmed seat-1.")], [{ id: "chaos/model" }]);
    const chaos = seedFailingOnce(ChaosFailure.RateLimited);
    const app = await appWithKeys(RetryingChaosApplication, {
      processEnv: {},
      providerFetch: stub.fetch,
      chaos,
    });

    const result = await execute(app, ChaosWorkflowStart, { text: "book a seat" });

    expect(result.finish).toMatchObject({ name: nameOf(ConfirmedWorkflowFinish) });
    expect(modelChaosOf(chaos).summary()).toMatchObject({
      calls: 2,
      injected: { "rate-limited": 1 },
    });
    expect(result.spend.totalUsd).toBeGreaterThan(0);
    await app.close();
  });

  it("without retries the failure takes .onError, whose path runs the reservation's undo", async () => {
    const stub = providerStub([completion("Confirmed seat-1.")], [{ id: "chaos/model" }]);
    const chaos: ChaosOptions = { rate: 1, seed: 7, failures: [ChaosFailure.Timeout] };
    const app = await appWithKeys(FragileChaosApplication, {
      processEnv: {},
      providerFetch: stub.fetch,
      chaos,
    });

    const result = await execute(app, ChaosWorkflowStart, { text: "book a seat" });

    expect(result.finish).toMatchObject({ name: nameOf(ReleasedWorkflowFinish) });
    expect(result.output).toEqual({ reservationId: "seat-1" });
    expect(stub.requests.filter((request) => request.url.endsWith("/chat/completions"))).toEqual(
      [],
    );
    expect(modelChaosOf(chaos).summary().injected.timeout).toBeGreaterThan(0);
    expect(result.compensations).toMatchObject([
      { compensator: { name: nameOf(ReleaseAction) }, reason: CompensationReason.SidePath },
    ]);
    await app.close();
  });
});
