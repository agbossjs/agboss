import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakers,
  ModelCallError,
  RetryPolicy,
} from "../../src/models/index.js";
import { connectionOf } from "../../src/models/connections.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { resilientFetch } from "../../src/models/resilient-fetch.js";
import { minutes, seconds } from "../../src/units/index.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";
import { completion, providerStub, type StubReply } from "./stub.js";

const policy = { failureThreshold: 3, window: minutes(1), openFor: seconds(30) };

/** A clock the test moves by hand. */
function clock() {
  let now = 0;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function breakerClient(replies: readonly StubReply[], time = clock()) {
  const stub = providerStub(replies);
  const breaker = new CircuitBreaker(policy, time.now);
  const send = resilientFetch(
    {
      provider: "openrouter",
      baseUrl: "http://openrouter.test/api/v1",
      timeout: seconds(5),
      retryPolicy: RetryPolicy.none(),
      breaker,
    },
    stub.fetch,
  );
  return {
    send: () => send("http://openrouter.test/api/v1/chat/completions"),
    stub,
    breaker,
    time,
  };
}

describe("AC6: the circuit breaker", () => {
  it("AC6: opens after failureThreshold failed calls within the window and fails fast with model.circuit-open", async () => {
    const { send, stub, breaker } = breakerClient([{ status: 500 }]);

    for (let call = 0; call < 3; call++) await send();

    expect(breaker.isOpen()).toBe(true);
    await expect(send()).rejects.toThrow(ModelCallError);
    await expect(send()).rejects.toMatchObject({
      code: "model.circuit-open",
      provider: "openrouter",
    });
    expect(stub.requests).toHaveLength(3);
  });

  it("AC6: failures spread wider than the window do not open it; a success clears the count", async () => {
    const { send, breaker, time } = breakerClient([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      completion(),
      { status: 500 },
    ]);

    await send();
    await send();
    time.advance(minutes(2));
    await send();
    expect(breaker.isOpen()).toBe(false);
    await send();
    await send();
    expect(breaker.isOpen()).toBe(false);
  });

  it("AC6: closes after openFor", async () => {
    const { send, breaker, time } = breakerClient([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      completion(),
    ]);
    for (let call = 0; call < 3; call++) await send();

    time.advance(seconds(30));

    expect(breaker.isOpen()).toBe(false);
    expect((await send()).status).toBe(200);
  });

  it("AC6: while open, calls go to the fallback provider — its base URL and its key", async () => {
    const primary = providerStub([{ status: 500 }]);
    const backup = providerStub([completion("from backup")]);
    const breakers = new CircuitBreakers();
    const options = modelProviderOf(TestOpenRouterProvider);
    const viaBackup: typeof fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("http://backup.test")
        ? backup.fetch(input, init)
        : primary.fetch(input, init);
    const connection = connectionOf(
      { ...options, retryPolicy: RetryPolicy.none() },
      { env: { OPENROUTER_API_KEY: "k" }, requireKeys: true, breakers, send: viaBackup },
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
    const breakers = new CircuitBreakers();
    const connection = connectionOf(
      { ...modelProviderOf(TestOpenRouterProvider), retryPolicy: RetryPolicy.none() },
      { env: { OPENROUTER_API_KEY: "k" }, requireKeys: true, breakers, send: failing.fetch },
    );
    for (let n = 0; n < 3; n++) await connection.fetch(`${connection.baseUrl}/x`);

    const replyWith = await connection.fetch(`${connection.baseUrl}/x`);

    expect(replyWith.status).toBe(503);
    expect(failing.requests.at(-1)?.url).toBe("http://backup.test/v1/x");
  });

  it("AC6: the breaker is shared per provider in the process", () => {
    const breakers = new CircuitBreakers();

    expect(breakers.of("openrouter", policy)).toBe(breakers.of("openrouter", policy));
    expect(breakers.of("openrouter", policy)).not.toBe(breakers.of("jev", policy));
  });
});
