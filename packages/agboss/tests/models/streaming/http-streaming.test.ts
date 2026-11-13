import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { transportApp } from "../transport/transport-app.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { StreamApplication } from "./http-streaming.fixture.js";
import {
  Gate,
  chunk,
  plainOf,
  sseEvents,
  sseServer,
  streamOf,
  type SseServer,
} from "./sse-server.js";

const deltas = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "textDelta" ? [event.delta] : []));

const servers: SseServer[] = [];
const serving = async (...args: Parameters<typeof sseServer>): Promise<SseServer> => {
  const server = await sseServer(...args);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("#1005 AC1: an HTTP provider streams the agent's answer token by token", () => {
  it("AC1: the tokens arrive one by one while the server still holds the rest", async () => {
    const gate = new Gate();
    const server = await serving([
      {
        steps: [
          sseEvents(chunk({ role: "assistant", content: "" })),
          sseEvents(chunk({ content: "Hel" })),
          { kind: "wait", gate },
          sseEvents(chunk({ content: "lo" })),
          ...streamOf([]).steps.slice(1),
        ],
      },
    ]);
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
    });
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ChatStart,
      { text: "hi" },
      {
        onStream: (event) => {
          events.push(event);
          if (deltas(events).join("") === "Hel") gate.open(); // only a streamed "Hel" opens the rest
        },
      },
    );

    expect(deltas(events)).toEqual(["Hel", "lo"]);
    expect(done.output).toEqual({ text: "Hello" });
    await app.close();
  });

  it("AC1: the call is sent with stream and include_usage; the joined deltas are the answer", async () => {
    const server = await serving([streamOf(["", "The ", "", "answer", " is 42."])]);
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
    });
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(app, ChatStart, { text: "q" }, { onStream: (e) => events.push(e) });

    const [request] = server.requests;
    expect(request?.body.stream).toBe(true);
    expect(request?.body.stream_options).toEqual({ include_usage: true });
    expect(deltas(events)).toEqual(["The", " answer", " is 42."]); // no empty token is an event; the reply is trimmed as #1007 does
    expect(deltas(events).join("")).toBe("The answer is 42.");
    expect(done.output).toEqual({ text: "The answer is 42." });
    await app.close();
  });

  it("AC1: a run without onStream sends no stream request", async () => {
    const server = await serving([streamOf(["x"])], plainOf("plain answer"));
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
    });

    const done = await execute(app, ChatStart, { text: "q" });

    expect(server.requests.map((request) => request.body.stream)).toEqual([false]);
    expect(done.output).toEqual({ text: "plain answer" });
    await app.close();
  });
});
