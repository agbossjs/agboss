import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionStreamEvent } from "../../../src/run/types.js";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { advanceUntilSettled, transportApp } from "../transport/transport-app.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { StreamApplication, StreamCostApplication } from "./http-streaming.fixture.js";
import { chunk, plainOf, sseEvents, sseServer, streamOf, type SseServer } from "./sse-server.js";

/** #1049: a server that ignores `stream: true` and answers a plain JSON completion. */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

// the modules a first execution loads lazily, loaded before any timer runs (#604)
beforeAll(async () => {
  const warm = await sseServer([streamOf(["warm"])]);
  const app = await transportApp(StreamApplication, {
    client: new ScriptedBedrockClient([]),
    send: warm.send,
  });
  await execute(app, ChatStart, { text: "warm" }, { onStream: () => undefined });
  await app.close();
  await warm.close();
}, 30_000);

const USAGE = { prompt_tokens: 120_000, completion_tokens: 30_000, total_tokens: 150_000 };

const deltas = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "textDelta" ? [event.delta] : []));

async function appOn(
  server: SseServer,
  application: typeof StreamApplication = StreamApplication,
  send: SseServer["send"] = server.send,
) {
  servers.push(server);
  return transportApp(application, { client: new ScriptedBedrockClient([]), send });
}

describe("#1049 AC1: a JSON answer to a streamed request is the call's completion", () => {
  it("the output, usage and cost are the plain call's; the text is one delta", async () => {
    const streamedServer = await sseServer([], plainOf("Hello there", USAGE), {});
    const plainServer = await sseServer([], plainOf("Hello there", USAGE), {});
    const streamedApp = await appOn(streamedServer);
    const plainApp = await appOn(plainServer);
    const events: ExecutionStreamEvent[] = [];

    const streamed = await execute(
      streamedApp,
      ChatStart,
      { text: "hi" },
      { onStream: (event) => events.push(event) },
    );
    const plain = await execute(plainApp, ChatStart, { text: "hi" });

    expect(streamedServer.requests[0]?.body.stream).toBe(true);
    expect(plainServer.requests[0]?.body.stream).toBe(false);
    expect(deltas(events)).toEqual(["Hello there"]);
    expect(streamed.output).toEqual({ text: "Hello there" });
    expect(streamed.output).toEqual(plain.output);
    expect(streamed.spend.totalUsd).toBeCloseTo(0.18, 9);
    expect(streamed.spend).toEqual(plain.spend);
    await streamedApp.close();
    await plainApp.close();
  });

  it("the cost the provider reports (usage.cost) is kept", async () => {
    const usage = { ...USAGE, cost: 0.0421 };
    const server = await sseServer([], plainOf("Hello", usage), {});
    const app = await appOn(server, StreamCostApplication);

    const done = await execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });

    expect(done.spend.totalUsd).toBeCloseTo(0.0421, 9);
    await app.close();
  });

  it("a finish_reason of length is handled as the plain call handles it", async () => {
    const cut = {
      ...(plainOf("Half an ans", USAGE) as Record<string, unknown>),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Half an ans" },
          finish_reason: "length",
        },
      ],
    };
    const outcome = async (streamed: boolean): Promise<string> => {
      const server = await sseServer([], cut, {});
      const app = await appOn(server);
      try {
        const done = await execute(
          app,
          ChatStart,
          { text: "hi" },
          streamed ? { onStream: () => undefined } : undefined,
        );
        return `ok ${JSON.stringify(done.output)}`;
      } catch (error) {
        return `failed ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        await app.close();
      }
    };

    expect(await outcome(true)).toBe(await outcome(false));
  });

  it("a fallback's answer to a streamed call may be JSON too", async () => {
    const primary = await sseServer([
      { steps: [sseEvents(chunk({ content: "Hel" })), { kind: "cut" }] },
    ]);
    const backup = await sseServer([], plainOf("from backup", USAGE), {});
    servers.push(backup);
    const send: SseServer["send"] = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return (url.includes("backup-1005") ? backup : primary).send(input, init);
    };
    const app = await appOn(primary, StreamApplication, send);
    const run = () => execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined });

    await expect(run()).rejects.toThrow();
    const done = await run(); // the breaker opened: the backup answers, in JSON

    expect(backup.requests[0]?.body.stream).toBe(true);
    expect(done.output).toEqual({ text: "from backup" });
    await app.close();
  });
});

describe("#1049 AC2: a streamed answer that is no stream and no completion is a call's failure", () => {
  const BAD = [
    ["an empty JSON body", { raw: "" }],
    ["a JSON that is no completion", { raw: '{"hello":"world"}' }],
    ["a text body", { type: "text/plain", raw: "hello" }],
    ["an empty event stream", { type: "text/event-stream", raw: "" }],
    ["an {error} inside the 200", { raw: '{"error":{"code":502,"message":"upstream failed"}}' }],
    ["a plain-string error inside the 200", { raw: '{"error":"overloaded"}' }],
  ] as const;

  it.each(BAD)("%s fails the run as the provider's, not as a configuration", async (_n, answer) => {
    const server = await sseServer([streamOf(["unused"])], undefined, answer);
    servers.push(server);
    const clock = new VirtualClock();
    const app = await transportApp(StreamApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
      clock,
    });

    const failure = await advanceUntilSettled(
      clock,
      execute(app, ChatStart, { text: "hi" }, { onStream: () => undefined }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure) + String(failure)).not.toContain("config.model-provider");
    expect(String(failure)).not.toContain("answered nothing");
    await app.close();
  });
});
