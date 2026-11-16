/**
 * #899 §2, §4: a part a model cannot take is `ModelCallError` `model.unsupported-input` — from a
 * transport's `ModelProviderInputError` and from an HTTP provider's 4xx — past the retry policy and
 * the circuit breaker: a client's input error opens no breaker for text calls, and it is no
 * fallback's business (`FallbackChatModel` falls back on `model.circuit-open` only).
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  ModelCallError,
  ModelFailure,
  ModelProviderInputError,
  RetryPolicy,
} from "../../src/models/index.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds } from "../../src/units/index.js";
import { ChatStart } from "../channels/approval.workflow.js";
import { execute } from "../helpers/flow.js";
import { instanceCalls } from "./gateway.js";
import { completion, providerStub, type StubReply } from "./stub.js";
import {
  BedrockApplication,
  TransportToHttpApplication,
} from "./transport/bedrock-apps.fixture.js";
import { answer, ScriptedBedrockClient } from "./transport/bedrock-provider.fixture.js";
import { transportApp } from "./transport/transport-app.js";

/** The ModelCallError the error or one of its causes is, if any. */
function callErrorOf(error: unknown): ModelCallError | undefined {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof ModelCallError) return cause;
  return undefined;
}

const REFUSED: StubReply = {
  status: 404,
  body: { error: { message: "No endpoints found that support image input", code: 404 } },
};

describe("AC1: a transport's ModelProviderInputError", () => {
  it("AC1: run-time ModelCallError without inputs, onError via cause — not retried, no breaker", async () => {
    const refusal = new ModelProviderInputError({ kind: "image", mediaType: "image/png" });
    const client = new ScriptedBedrockClient([
      ...Array.from({ length: 6 }, () => refusal),
      answer("fine"),
    ]);
    const app = await transportApp(BedrockApplication, { client });

    const failures: unknown[] = [];
    // more than the breaker's threshold (5): had they counted, the breaker would be open
    for (let call = 0; call < 6; call++)
      failures.push(await execute(app, ChatStart, { text: "hi" }).catch((error: unknown) => error));
    const next = await execute(app, ChatStart, { text: "a text call" });

    expect(failures.map((failure) => callErrorOf(failure)?.code)).toEqual(
      Array(6).fill("model.unsupported-input"),
    );
    expect(callErrorOf(failures[0])).toMatchObject({
      provider: "bedrock-model-provider",
      model: "bedrock/claude",
      kind: "image",
      mediaType: "image/png",
    });
    expect(client.invocations).toHaveLength(7);
    expect(next.output).toEqual({ text: "fine" });
    await app.close();
  });
});

describe("AC1: an HTTP provider's 4xx that names an unsupported input", () => {
  function client(replies: readonly StubReply[], retryOn: readonly ModelFailure[] = []) {
    const clock = new VirtualClock();
    const stub = providerStub(replies);
    const breaker = instanceCalls(clock, new InMemoryDatabase(), "instance-1").breakerOf(
      "openrouter",
      { failureThreshold: 2, window: minutes(1), openFor: seconds(30) },
    );
    const send = resilientFetch(
      {
        provider: "openrouter",
        timeout: seconds(5),
        retryPolicy: RetryPolicy.fixed({ maxAttempts: 3, delay: seconds(1), retryOn }),
        breaker,
        clock,
      },
      stub.fetch,
    );
    const sent = JSON.stringify({
      model: "a/b",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        },
      ],
    });
    return {
      stub,
      breaker,
      call: () => send("http://openrouter.test/chat/completions", { method: "POST", body: sent }),
    };
  }

  it("AC1: it is model.unsupported-input naming the model, kind and media type; the breaker stays closed", async () => {
    const { call, breaker, stub } = client([REFUSED]);

    const failures = await Promise.all(
      [1, 2, 3].map(() => call().catch((error: unknown) => error)),
    );

    expect(failures.map((failure) => callErrorOf(failure)?.code)).toEqual(
      Array(3).fill("model.unsupported-input"),
    );
    expect(callErrorOf(failures[0])).toMatchObject({
      provider: "openrouter",
      model: "a/b",
      kind: "image",
      mediaType: "image/png",
    });
    expect(stub.requests).toHaveLength(3);
    expect(await breaker.isOpen()).toBe(false);
  });

  it("a 4xx that says nothing of inputs is the answer as it was; a 5xx still counts", async () => {
    const { call, breaker } = client([
      { status: 400, body: { error: { message: "bad temperature" } } },
      { status: 500 },
      { status: 500 },
    ]);

    expect((await call()).status).toBe(400);
    await call();
    await call();

    expect(await breaker.isOpen()).toBe(true);
    expect(completion().body).toBeDefined();
  });

  it("is never retried even where a retry policy retries every failure", async () => {
    const { call, stub } = client([REFUSED], [ModelFailure.ServerError, ModelFailure.Timeout]);

    await call().catch((error: unknown) => error);

    expect(stub.requests).toHaveLength(1);
  });
});

describe("AC1: an unsupported input never falls back silently", () => {
  it("AC1: the breaker's fallback is for model.circuit-open only: the backup gets no call", async () => {
    const refusal = new ModelProviderInputError({ kind: "file", mediaType: "application/pdf" });
    const client = new ScriptedBedrockClient([refusal]);
    const backup = providerStub([completion("from backup")]);
    const app = await transportApp(TransportToHttpApplication, { client, send: backup.fetch });

    const failure = await execute(app, ChatStart, { text: "hi" }).catch((error: unknown) => error);

    expect(callErrorOf(failure)?.code).toBe("model.unsupported-input");
    expect(backup.requests).toHaveLength(0);
    await app.close();
  });
});
