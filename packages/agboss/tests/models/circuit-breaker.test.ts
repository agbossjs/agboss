import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { ModelCallError, ModelProviderDirectory, RetryPolicy } from "../../src/models/index.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { connectionOf } from "../../src/models/connections.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds } from "../../src/units/index.js";
import { ENV, instanceCalls, KEYS } from "./gateway.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";
import { completion, providerStub, type StubReply } from "./stub.js";

const policy = { failureThreshold: 3, window: minutes(1), openFor: seconds(30) };
const AGENT = { kind: "agent", agent: "scout" } as const;
const KIMI = { model: "moonshotai/kimi-k2.6", temperature: 0, maxTokens: 1 };

/** OpenRouter's gateway (its fallback: the backup) with its breaker already open (#385: the chat model falls back). */
async function openedGateway(send: typeof fetch) {
  const calls = instanceCalls();
  const options = modelProviderOf(TestOpenRouterProvider);
  const breaker = calls.breakerOf(options.name, options.circuitBreakerPolicy);
  for (let failure = 0; failure < 3; failure++) await breaker.recordFailure();
  const directory = ModelProviderDirectory.of([TestOpenRouterProvider]);
  return createProviderGateway(directory, { env: ENV, environment: KEYS, calls, send });
}

/** A client of one provider on one instance; two clients over one database are two instances. */
function breakerClient(
  replies: readonly StubReply[],
  clock = new VirtualClock(),
  database = new InMemoryDatabase(),
  instanceId = "instance-1",
) {
  const stub = providerStub(replies);
  const breaker = instanceCalls(clock, database, instanceId).breakerOf("openrouter", policy);
  const send = resilientFetch(
    {
      provider: "openrouter",
      timeout: seconds(5),
      retryPolicy: RetryPolicy.none(),
      breaker,
      clock,
    },
    stub.fetch,
  );
  return {
    send: () => send("http://openrouter.test/api/v1/chat/completions"),
    stub,
    breaker,
    clock,
  };
}

describe("AC6: the circuit breaker", () => {
  it("AC6: opens after failureThreshold failed calls within the window and fails fast with model.circuit-open", async () => {
    const { send, stub, breaker } = breakerClient([{ status: 500 }]);

    for (let call = 0; call < 3; call++) await send();

    expect(await breaker.isOpen()).toBe(true);
    await expect(send()).rejects.toThrow(ModelCallError);
    await expect(send()).rejects.toMatchObject({
      code: "model.circuit-open",
      provider: "openrouter",
    });
    expect(stub.requests).toHaveLength(3);
  });

  it("AC6: failures spread wider than the window do not open it; a success clears the count", async () => {
    const { send, breaker, clock } = breakerClient([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      completion(),
      { status: 500 },
    ]);

    await send();
    await send();
    await clock.advance(minutes(2));
    await send();
    expect(await breaker.isOpen()).toBe(false);
    await send();
    await send();
    expect(await breaker.isOpen()).toBe(false);
  });

  it("AC6: closes after openFor — on the application's clock", async () => {
    const { send, breaker, clock } = breakerClient([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      completion(),
    ]);
    for (let call = 0; call < 3; call++) await send();

    await clock.advance(seconds(30));

    expect(await breaker.isOpen()).toBe(false);
    expect((await send()).status).toBe(200);
  });

  it("#265 S52: the breaker's state is in RateLimitRepository — opened on one instance, open on the other", async () => {
    const clock = new VirtualClock();
    const database = new InMemoryDatabase();
    const first = breakerClient([{ status: 500 }], clock, database, "instance-1");
    const second = breakerClient([completion()], clock, database, "instance-2");

    for (let call = 0; call < 3; call++) await first.send();

    await expect(second.send()).rejects.toMatchObject({ code: "model.circuit-open" });
    expect(second.stub.requests).toEqual([]);
    await clock.advance(seconds(30));
    expect((await second.send()).status).toBe(200);
  });

  it("AC6: while open, calls go to the fallback provider — its base URL, its key and its model", async () => {
    const backup = providerStub([completion("from backup")]);
    const gateway = await openedGateway(backup.fetch);

    const answer = await gateway.chatModel({ user: AGENT, settings: KIMI }).invoke("hi");

    expect(answer.text).toBe("from backup");
    expect(backup.requests[0]).toMatchObject({
      url: "http://backup.test/v1/chat/completions",
      authorization: "Bearer backup-key",
      body: expect.objectContaining({ model: "backup/kimi-k2.6" }),
    });
  });

  it("#649: the tools' binding reaches the fallback's request: parallel_tool_calls: false", async () => {
    const backup = providerStub([completion("from backup")]);
    const gateway = await openedGateway(backup.fetch);
    const answerOnly = {
      type: "function",
      function: { name: "answer-x-dto", description: "x", parameters: { type: "object" } },
    } as const;

    const model = gateway.chatModel({ user: AGENT, settings: KIMI });
    await model.bindTools?.([answerOnly], { parallel_tool_calls: false } as object).invoke("hi");

    expect(backup.requests[0]?.body).toMatchObject({ parallel_tool_calls: false });
  });

  it("AC6: the breaker open while the fallback also fails: the fallback's failure is the call's", async () => {
    const failing = providerStub([{ status: 503 }]);
    const gateway = await openedGateway(failing.fetch);

    await expect(gateway.chatModel({ user: AGENT, settings: KIMI }).invoke("hi")).rejects.toThrow();
    expect(failing.requests.map((request) => request.url)).toEqual([
      "http://backup.test/v1/chat/completions",
    ]);
  });

  it("AC6: without the instance's shared calls (the model check) a connection has no breaker", async () => {
    const failing = providerStub([{ status: 500 }]);
    const connection = connectionOf(
      { ...modelProviderOf(TestOpenRouterProvider), retryPolicy: RetryPolicy.none() },
      { env: ENV, environment: KEYS, requireKeys: false, send: failing.fetch },
    );

    for (let n = 0; n < 4; n++) await connection.fetch(`${connection.baseUrl}/x`);

    expect(failing.requests.map((request) => request.url)).toEqual(
      Array.from({ length: 4 }, () => "http://openrouter.test/api/v1/x"),
    );
  });
});
