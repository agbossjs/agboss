import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { transportApp } from "../transport/transport-app.js";
import { StreamOpenRouterApplication } from "./http-streaming.fixture.js";
import { sseEvents, sseServer, type SseServer } from "./sse-server.js";
import { StreamEventKind } from "../../../src/run/types.js";

/**
 * #1231: a stream recorded live from OpenRouter (`mistralai/mistral-nemo`, 2026-11-16; ids,
 * timestamps and the fingerprint scrubbed), replayed byte for byte on 127.0.0.1. Its last chunk
 * carries a finish choice and the usage together; a finish chunk without usage comes before it.
 */

const LINES = readFileSync(new URL("fixtures/openrouter-live-stream.sse", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.startsWith("data: "))
  .map((line) => line.slice("data: ".length));

/** What the recording's own usage chunk says. */
function wireUsage(): { cost: number; prompt_tokens: number; completion_tokens: number } {
  const last = LINES.filter((line) => line.includes('"usage"')).at(-1) ?? "{}";
  const { usage } = JSON.parse(last) as {
    usage: { cost: number; prompt_tokens: number; completion_tokens: number };
  };
  return usage;
}

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("#1231: a live OpenRouter stream, replayed", () => {
  it("records the wire's usage.cost, tokens and host once", async () => {
    const server = await sseServer([{ steps: LINES.map((line) => sseEvents(line)) }]);
    servers.push(server);
    const app = await transportApp(StreamOpenRouterApplication, {
      client: new ScriptedBedrockClient([]),
      send: server.send,
    });
    const deltas: string[] = [];

    const done = await execute(
      app,
      ChatStart,
      { text: "Say hi in five words." },
      {
        onStream: (event) =>
          event.kind === StreamEventKind.TextDelta ? deltas.push(event.delta) : undefined,
      },
    );
    await app.close();

    const usage = wireUsage();
    expect(LINES.filter((line) => line.includes('"usage"'))).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(1);
    expect(done.spend.trace).toEqual([
      expect.objectContaining({
        costUsd: usage.cost,
        costSource: "api",
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        servedBy: "Io Net",
      }),
    ]);
    expect(done.spend.totalUsd).toBe(usage.cost);
  });
});
