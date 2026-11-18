/**
 * #1125 AC1+AC3 at a real 127.0.0.1 server: it streams half an answer and goes quiet; the provider's
 * timeout (30 s on the `VirtualClock`) fails the call — never a success after the stall — the text so
 * far is retracted (`stream-broken`), and the call is not retried.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import { ModelFailure } from "../../../src/models/index.js";
import { failureOfError } from "../../../src/models/model-failure.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { advanceUntilSettled, transportApp } from "../transport/transport-app.js";
import { StreamApplication } from "./http-streaming.fixture.js";
import { Gate, chunk, sseEvents, sseServer, streamOf, type SseServer } from "./sse-server.js";

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("#1125: a stream that stalls after its first tokens", { timeout: 30_000 }, () => {
  // the modules a first execution loads lazily, loaded before any clock moves (#604)
  beforeAll(async () => {
    const warm = await sseServer([streamOf(["warm"])]);
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: warm.send,
    });
    await execute(app, ChatStart, { text: "warm" }, { onStream: () => undefined });
    await app.close();
    await warm.close();
  }, 20_000);

  it("fails at the timeout, retracts what streamed, is not retried and is no success", async () => {
    const stall = new Gate();
    const server = await sseServer([
      {
        steps: [
          sseEvents(chunk({ content: "One " })),
          sseEvents(chunk({ content: "two" })),
          { kind: "wait", gate: stall },
          sseEvents(chunk({ content: " three" })),
        ],
      },
    ]);
    servers.push(server);
    const clock = new VirtualClock();
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
      clock,
    });
    const events: ExecutionStreamEvent[] = [];

    const failure = await advanceUntilSettled(
      clock,
      execute(app, ChatStart, { text: "hi" }, { onStream: (event) => events.push(event) }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    stall.open();

    expect(failure).toBeInstanceOf(Error);
    expect(server.requests).toHaveLength(1); // text was out: no retry
    expect(events.map((event) => (event.kind === "textDelta" ? event.delta : event.kind))).toEqual([
      "One",
      " two",
      "discarded",
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "discarded", reason: "stream-broken" });
    await app.close();
  });

  // a provider that sends only `:` comments after its first content is as quiet as one that sends nothing
  it("a comment every second after the first tokens does not keep the stream alive: it fails as a timeout, no retry", async () => {
    const stop = new Gate();
    class CountingClock extends VirtualClock {
      advances = 0;
      override advance(duration: Parameters<VirtualClock["advance"]>[0]): Promise<void> {
        this.advances += 1;
        return super.advance(duration);
      }
    }
    const clock = new CountingClock();
    const server = await sseServer([
      {
        steps: [
          sseEvents(chunk({ content: "One " })),
          { kind: "comments", clock, every: seconds(1), until: stop },
        ],
      },
    ]);
    servers.push(server);
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
      clock,
    });
    const events: ExecutionStreamEvent[] = [];

    const failure = await advanceUntilSettled(
      clock,
      execute(app, ChatStart, { text: "hi" }, { onStream: (event) => events.push(event) }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    stop.open();

    expect(failure).toBeInstanceOf(Error);
    expect(failureOfError((failure as Error).cause)).toBe(ModelFailure.Timeout); // the agent step failed with the stall
    // the provider's bound is 30 s, a step is a second: not at the first comment, not never (they go on for ever)
    expect(clock.advances).toBeGreaterThanOrEqual(30);
    expect(clock.advances).toBeLessThanOrEqual(34);
    expect(server.requests).toHaveLength(1); // text was out: no retry
    expect(events.at(-1)).toMatchObject({ kind: "discarded", reason: "stream-broken" });
    await app.close();
  });
});
