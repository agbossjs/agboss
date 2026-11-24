import { beforeAll, describe, expect, it } from "vitest";
import { StreamEventKind, type ExecutionStreamEvent } from "../../../src/run/types.js";
import {
  ModelCallError,
  ModelFailure,
  ModelProviderFailureError,
} from "../../../src/models/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { VerdictStart } from "../transport/bedrock-apps.fixture.js";
import { advanceUntilSettled, transportApp } from "../transport/transport-app.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import {
  ScriptedStreamClient,
  StreamSdkClient,
  TransportStreamApplication,
  abortedAfter,
  failingAfter,
  failingFirst,
  silentAfter,
  streamOf,
  usageNeverSettles,
  usageOf,
  usageRejects,
  type StreamScript,
} from "./transport-streaming.fixture.js";

/**
 * #1011: a transport provider's `stream(request)` — `{ textStream, usage }` — streams its text
 * through the one attempt runner. A provider without `stream` keeps the one delta
 * (`provider-kinds.test.ts`).
 */

const deltas = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => (event.kind === StreamEventKind.TextDelta ? [event.delta] : []));

async function appOn(scripts: readonly StreamScript[], clock = new VirtualClock()) {
  const client = new ScriptedStreamClient(scripts);
  const app = await transportApp(TransportStreamApplication, {
    client: new ScriptedBedrockClient([]),
    clock,
    overrides: new Map([[StreamSdkClient, client]]),
  });
  return { app, client, clock };
}

describe("#1011: a transport provider streams its text", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const { app } = await appOn([streamOf(["warm"])]);
    await execute(app, ChatStart, { text: "warm" }, { onStream: () => undefined });
    await app.close();
  }, 30_000);

  it("AC1: the chunks are delivered in order, as they come; the answer is their concatenation", async () => {
    const { app, client } = await appOn([streamOf(["a", "b", "c"])]);
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(app, ChatStart, { text: "hi" }, { onStream: (e) => events.push(e) });

    expect(deltas(events)).toEqual(["a", "b", "c"]);
    expect(done.output).toEqual({ text: "abc" });
    expect(client.opened).toHaveLength(1);
    expect(client.completed).toHaveLength(0);
    await app.close();
  });

  it("AC3: the usage is counted once, as the plain call's (tokens x price)", async () => {
    const { app } = await appOn([streamOf(["a", "b"], usageOf(1_000_000, 500_000))]);

    const done = await execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });

    expect(done.spend.trace).toHaveLength(1);
    expect(done.spend.trace[0]?.inputTokens).toBe(1_000_000);
    expect(done.spend.trace[0]?.outputTokens).toBe(500_000);
    expect(done.spend.totalUsd).toBeCloseTo(2, 6); // 1 x $1 + 0.5 x $2
    await app.close();
  });

  it("AC1: a call with tools bound (an answer tool) goes through complete(): a text stream cannot carry a tool call", async () => {
    const { app, client } = await appOn([streamOf(["never"])]);

    await execute(app, VerdictStart, { text: "case" }, { onStream: () => undefined }).catch(
      () => undefined,
    );

    expect(client.opened).toHaveLength(0);
    expect(client.completed.length).toBeGreaterThan(0);
    await app.close();
  });

  it("AC2: a failure before the first chunk is retried by the retry policy, and the second stream answers", async () => {
    const failure = new ModelProviderFailureError({ failure: ModelFailure.ServerError });
    const { app, client, clock } = await appOn([failingFirst(failure), streamOf(["ok"])]);
    const events: ExecutionStreamEvent[] = [];

    const done = await advanceUntilSettled(
      clock,
      execute(app, ChatStart, { text: "hi" }, { onStream: (e) => events.push(e) }),
    );

    expect(client.opened).toHaveLength(2);
    expect(deltas(events)).toEqual(["ok"]); // nothing of the failed attempt went out
    expect(done.spend.trace).toHaveLength(1); // one call, paid once
    await app.close();
  });

  it.each([
    [
      "the stream throws, its usage settles",
      () =>
        failingAfter(["Hel"], new ModelProviderFailureError({ failure: ModelFailure.ServerError })),
    ],
    [
      "the stream throws, its usage rejects",
      () =>
        failingAfter(
          ["Hel"],
          new ModelProviderFailureError({ failure: ModelFailure.ServerError }),
          "rejects",
        ),
    ],
  ] as const)(
    "AC2: after text, %s: the typed error surfaces, no retry, the breaker counts it, never a success",
    async (_name, script) => {
      const { app, client } = await appOn([script()]);
      const run = () => execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });

      await expect(run()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ModelProviderFailureError || causedBy(error, ModelProviderFailureError),
      );
      await expect(run()).rejects.toThrow();
      // the second failed call is the threshold's (2): the breaker is open now
      await expect(run()).rejects.toSatisfy((error: unknown) => causedBy(error, ModelCallError));

      expect(client.opened).toHaveLength(2); // never retried; the third was refused by the breaker
      await app.close();
    },
  );

  it("AC2: a clean end whose usage rejects is a failed call, not a success", async () => {
    const error = new ModelProviderFailureError({ failure: ModelFailure.ServerError });
    const { app, client } = await appOn([usageRejects(["x"], error)]);
    const run = () => execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });

    await expect(run()).rejects.toThrow();
    await expect(run()).rejects.toThrow();
    await expect(run()).rejects.toSatisfy((e: unknown) => causedBy(e, ModelCallError));

    expect(client.opened).toHaveLength(2);
    await app.close();
  });

  it("a usage that never settles is a typed timeout at the provider's timeout, never a hang", async () => {
    const { app, clock } = await appOn([usageNeverSettles(["x"])]);

    const run = execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });
    const outcome = await advanceUntilSettled(
      clock,
      run.then(
        () => undefined,
        (error: unknown) => error,
      ),
    );

    expect(outcome).toSatisfy((e: unknown) => causedBy(e, ModelProviderFailureError));
    expect(failureOf(outcome)).toBe(ModelFailure.Timeout);
    await app.close();
  });

  it("a stream that goes silent after its first chunk is cut at the provider's timeout, typed", async () => {
    const { app, client, clock } = await appOn([silentAfter(["x"])]);

    const run = execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });
    const outcome = await advanceUntilSettled(
      clock,
      run.then(
        () => undefined,
        (error: unknown) => error,
      ),
    );

    expect(failureOf(outcome)).toBe(ModelFailure.Timeout);
    expect(client.opened[0]?.signal.aborted).toBe(true); // the SDK is told to stop
    await app.close();
  });

  it("a caller's abort mid-stream ends the call and is neither a success nor a failure of the provider", async () => {
    const { app, client } = await appOn([abortedAfter(["x"])]);
    const abort = async (): Promise<void> => {
      const controller = new AbortController();
      const run = execute(
        app,
        ChatStart,
        { text: "hi" },
        {
          signal: controller.signal,
          onStream: () => {
            controller.abort();
          },
        },
      );
      await expect(run).rejects.toThrow();
    };

    await abort();
    await abort();
    await abort();

    expect(client.opened).toHaveLength(3); // three aborts did not open the breaker (threshold 2)
    await app.close();
  });
});

/** The error and its causes, outermost first. */
function chainOf(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) chain.push(cause);
  return chain;
}

/** Whether the error or one of its causes is an instance of `cls`. */
const causedBy = (error: unknown, cls: abstract new (...args: never[]) => Error): boolean =>
  chainOf(error).some((cause) => cause instanceof cls);

/** The `failure` of the first `ModelProviderFailureError` in the chain. */
const failureOf = (error: unknown): ModelFailure | undefined =>
  chainOf(error).flatMap((cause) =>
    cause instanceof ModelProviderFailureError ? [cause.failure] : [],
  )[0];
