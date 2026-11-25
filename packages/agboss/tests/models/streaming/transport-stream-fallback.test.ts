import { afterEach, describe, expect, it } from "vitest";
import { StreamEventKind, type ExecutionStreamEvent } from "../../../src/run/types.js";
import { ModelFailure, ModelProviderFailureError } from "../../../src/models/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { transportApp } from "../transport/transport-app.js";
import { streamOf as sseStreamOf, sseServer, type SseServer } from "./sse-server.js";
import {
  ScriptedStreamClient,
  StreamSdkClient,
  failingAfter,
  failingFirst,
  type StreamScript,
} from "./transport-streaming.fixture.js";
import { TransportStreamFallbackApplication } from "./transport-stream-fallback.fixture.js";

/**
 * #1311b: a transport primary streams its chunks live, and a stream that breaks is failed over
 * within the same stream: before any text transparently, after text with the text retracted first.
 */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** What the run's stream said, in order: a delta as its text, a retraction as `[discarded]`. */
const told = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => {
    if (event.kind === StreamEventKind.TextDelta) return [event.delta];
    return event.kind === StreamEventKind.Discarded ? ["[discarded]"] : [];
  });

async function appOn(primary: StreamScript) {
  const backup = await sseServer([sseStreamOf(["from", " backup"])]);
  servers.push(backup);
  const client = new ScriptedStreamClient([primary]);
  const app = await transportApp(TransportStreamFallbackApplication, {
    client: new ScriptedBedrockClient([]),
    clock: new VirtualClock(),
    send: backup.send,
    overrides: new Map([[StreamSdkClient, client]]),
  });
  return { app, client };
}

const failure = (): Error => new ModelProviderFailureError({ failure: ModelFailure.ServerError });

describe("#1311b: a transport stream's chunks are live and its failure fails over in the stream", () => {
  it("the chunks of a call without a failure reach the run one by one", async () => {
    const { app } = await appOn(() => ({
      textStream: (async function* () {
        await Promise.resolve();
        yield* ["a", "b", "c"];
      })(),
      result: Promise.resolve({
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    }));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(app, ChatStart, { text: "hi" }, { onStream: (e) => events.push(e) });

    expect(told(events)).toEqual(["a", "b", "c"]);
    expect(done.output).toEqual({ text: "abc" });
    await app.close();
  });

  it("a failure before any text is answered by the fallback with nothing retracted", async () => {
    const { app } = await appOn(failingFirst(failure()));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(app, ChatStart, { text: "hi" }, { onStream: (e) => events.push(e) });

    expect(told(events)).toEqual(["from", " backup"]);
    expect(done.output).toEqual({ text: "from backup" });
    await app.close();
  });

  it("a failure after text retracts it and the fallback answers from the start", async () => {
    const { app } = await appOn(failingAfter(["Hel"], failure()));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(app, ChatStart, { text: "hi" }, { onStream: (e) => events.push(e) });

    expect(told(events)).toEqual(["Hel", "[discarded]", "from", " backup"]);
    expect(done.output).toEqual({ text: "from backup" });
    await app.close();
  });
});
