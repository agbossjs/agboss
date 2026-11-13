import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { HttpToTransportApplication } from "../transport/bedrock-apps.fixture.js";
import { answer, ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { transportApp } from "../transport/transport-app.js";
import { StreamApplication } from "./http-streaming.fixture.js";
import {
  chunk,
  sseEvents,
  sseServer,
  streamOf,
  type SseScript,
  type SseServer,
} from "./sse-server.js";

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** What the run's stream said, in order: a delta as its text, a discard as `[discarded]`. */
const told = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => {
    if (event.kind === "textDelta") return [event.delta];
    return event.kind === "discarded" ? ["[discarded]"] : [];
  });

const cutAfterHello: SseScript = {
  steps: [sseEvents(chunk({ content: "Hel" })), { kind: "cut" }],
};

async function twoServers(primary: SseScript, backup: SseScript = streamOf(["from", " backup"])) {
  const first = await sseServer([primary]);
  const second = await sseServer([backup]);
  servers.push(first, second);
  const send: SseServer["send"] = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return (url.includes("backup-1005") ? second : first).send(input, init);
  };
  return { first, second, send };
}

const quiet = { onStream: () => undefined };

describe("#1005 AC4: a fallback model's answer streams like the primary's", () => {
  it("a primary that dies mid-stream and opens its breaker: the text is discarded, the backup answers whole", async () => {
    const { send } = await twoServers(cutAfterHello);
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send,
    });
    await expect(execute(app, ChatStart, { text: "one" }, quiet)).rejects.toThrow();
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ChatStart,
      { text: "two" },
      { onStream: (event) => events.push(event) },
    );

    expect(told(events)).toEqual(["Hel", "[discarded]", "from", " backup"]);
    expect(events.find((event) => event.kind === "discarded")).toMatchObject({
      reason: "stream-broken",
      step: { agent: "stream-1005-agent", attempt: 1 },
    });
    expect(done.output).toEqual({ text: "from backup" });
    expect(done.spend.byModel).toEqual({ "backup-stream/model": 0.0002 }); // the backup's model and prices
    expect(done.spend.trace).toHaveLength(1);
    await app.close();
  });

  it("with the breaker already open, the backup's tokens stream from the start", async () => {
    const { first, send } = await twoServers(cutAfterHello);
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send,
    });
    await expect(execute(app, ChatStart, { text: "one" }, quiet)).rejects.toThrow();
    await execute(app, ChatStart, { text: "two" }, quiet);
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ChatStart,
      { text: "three" },
      { onStream: (event) => events.push(event) },
    );

    expect(told(events)).toEqual(["from", " backup"]); // no discard: nothing was streamed before
    expect(first.requests).toHaveLength(2); // the primary is not called while its breaker is open
    expect(done.output).toEqual({ text: "from backup" });
    await app.close();
  });

  it("an HTTP primary that dies mid-stream falls back to a transport: one delta after the discard", async () => {
    const primary = await sseServer([cutAfterHello]);
    servers.push(primary);
    const client = new ScriptedBedrockClient([answer("From the transport.")]);
    const app = await transportApp(HttpToTransportApplication, { client, send: primary.send });
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ChatStart,
      { text: "hi" },
      { onStream: (event) => events.push(event) },
    );

    expect(told(events)).toEqual(["Hel", "[discarded]", "From the transport."]);
    expect(done.output).toEqual({ text: "From the transport." });
    await app.close();
  });
});
