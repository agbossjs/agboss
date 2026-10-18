import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { ModelCallError, RetryPolicy } from "../../src/models/index.js";
import { connectionOf } from "../../src/models/connections.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { minutes, seconds } from "../../src/units/index.js";
import { ENV, instanceCalls, KEYS } from "./gateway.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";
import { completion, providerStub, type StubReply } from "./stub.js";

const policy = { failureThreshold: 3, window: minutes(1), openFor: seconds(30) };

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
      baseUrl: "http://openrouter.test/api/v1",
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

  it("AC6: while open, calls go to the fallback provider — its base URL and its key", async () => {
    const primary = providerStub([{ status: 500 }]);
    const backup = providerStub([completion("from backup")]);
    const options = modelProviderOf(TestOpenRouterProvider);
    const viaBackup: typeof fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("http://backup.test")
        ? backup.fetch(input, init)
        : primary.fetch(input, init);
    const connection = connectionOf(
      { ...options, retryPolicy: RetryPolicy.none() },
      { env: ENV, environment: KEYS, requireKeys: true, calls: instanceCalls(), send: viaBackup },
    );
    const call = () =>
      connection.fetch(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer k" },
        body: "{}",
      });

    for (let n = 0; n < 3; n++) await call();
    const replyWith = await call();

    expect(replyWith.status).toBe(200);
    expect(backup.requests[0]).toMatchObject({
      url: "http://backup.test/v1/chat/completions",
      authorization: "Bearer backup-key",
    });
  });

  it("AC6: the breaker open while the fallback also fails: the fallback's failure is the replyWith", async () => {
    const failing = providerStub([{ status: 503 }]);
    const connection = connectionOf(
      { ...modelProviderOf(TestOpenRouterProvider), retryPolicy: RetryPolicy.none() },
      {
        env: ENV,
        environment: KEYS,
        requireKeys: true,
        calls: instanceCalls(),
        send: failing.fetch,
      },
    );
    for (let n = 0; n < 3; n++) await connection.fetch(`${connection.baseUrl}/x`);

    const replyWith = await connection.fetch(`${connection.baseUrl}/x`);

    expect(replyWith.status).toBe(503);
    expect(failing.requests.at(-1)?.url).toBe("http://backup.test/v1/x");
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
