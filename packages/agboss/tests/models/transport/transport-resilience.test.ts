/**
 * #385 — every policy of the gateway runs around `complete()` as around HTTP, through the one
 * attempt runner: `retryPolicy` on a `ModelProviderFailureError`, a 429's `retryAfter` pausing the
 * provider's whole queue, the attempt's timeout on an SDK that ignores its signal, any other error
 * not retried but counted by the breaker — open, it fails fast and readiness is `Degraded`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { HealthComponentKind, HealthStatus } from "../../../src/index.js";
import {
  ModelCallError,
  ModelFailure,
  ModelProviderFailureError,
} from "../../../src/models/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { BedrockApplication } from "./bedrock-apps.fixture.js";
import { answer, ScriptedBedrockClient } from "./bedrock-provider.fixture.js";
import { advanceUntilSettled, transportApp, warmedUp } from "./transport-app.js";

/** When each call came, in seconds after the first. */
const secondsOf = (client: ScriptedBedrockClient): readonly number[] =>
  client.invocations.map((call) => (call.at - (client.invocations[0]?.at ?? 0)) / 1000);

/** Whether the error or one of its causes is the breaker's fail-fast. */
function isCircuitOpen(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause)
    if (cause instanceof ModelCallError) return true;
  return false;
}

describe("#385: the gateway's policies run around complete()", { timeout: 20_000 }, () => {
  // the modules a first execution loads lazily, loaded before any clock moves (#604)
  beforeAll(() => warmedUp(BedrockApplication, ChatStart), 20_000);

  it("retryPolicy: a ModelFailure.ServerError is retried after its backoff — one call, paid once", async () => {
    const clock = new VirtualClock();
    const failure = new ModelProviderFailureError(ModelFailure.ServerError);
    const client = new ScriptedBedrockClient([failure, answer("ok")], clock);
    const app = await transportApp(BedrockApplication, { client, clock });

    const result = await advanceUntilSettled(clock, execute(app, ChatStart, { text: "hi" }));

    expect(result.output).toEqual({ text: "ok" });
    expect(secondsOf(client)).toEqual([0, 1]);
    expect(result.spend.trace).toHaveLength(1);
    await app.close();
  });

  it("a 429 with retryAfter pauses the provider's whole queue: another execution waits too", async () => {
    const clock = new VirtualClock();
    const limited = new ModelProviderFailureError(ModelFailure.RateLimited, {
      retryAfter: seconds(3),
    });
    const client = new ScriptedBedrockClient([limited, answer("ok")], clock);
    const app = await transportApp(BedrockApplication, { client, clock });

    const first = execute(app, ChatStart, { text: "one" });
    await clock.advance(seconds(1));
    const second = execute(app, ChatStart, { text: "two" });
    await advanceUntilSettled(clock, Promise.all([first, second]));

    expect(secondsOf(client)).toEqual([0, 3, 3]);
    await app.close();
  });

  it("an SDK that ignores its signal is cut at the provider's timeout and retried as a Timeout", async () => {
    const clock = new VirtualClock();
    const hangs = (): Promise<never> => new Promise<never>(() => undefined);
    const client = new ScriptedBedrockClient([hangs, answer("ok")], clock);
    const app = await transportApp(BedrockApplication, { client, clock });

    const result = await advanceUntilSettled(clock, execute(app, ChatStart, { text: "hi" }));

    expect(result.output).toEqual({ text: "ok" });
    expect(secondsOf(client)).toEqual([0, 31]);
    await app.close();
  });

  it("any other error is not retried; five open the breaker: fail fast, no call, readiness Degraded", async () => {
    const client = new ScriptedBedrockClient([new Error("ValidationException")]);
    const app = await transportApp(BedrockApplication, { client });

    for (let call = 0; call < 5; call++)
      await expect(execute(app, ChatStart, { text: "hi" })).rejects.toThrow();
    const failed = await execute(app, ChatStart, { text: "hi" }).catch((error: unknown) => error);
    const report = await app.checkReadiness();

    expect(client.invocations).toHaveLength(5);
    expect(isCircuitOpen(failed)).toBe(true);
    expect(report.components).toContainEqual(
      expect.objectContaining({
        name: "bedrock-model-provider",
        kind: HealthComponentKind.ModelProvider,
        status: HealthStatus.Degraded,
      }),
    );
    await app.close();
  });
});
