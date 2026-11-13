import { afterEach, describe, expect, it } from "vitest";
import { ChatStart } from "../../channels/approval.workflow.js";
import { execute } from "../../helpers/flow.js";
import { ScriptedBedrockClient } from "../transport/bedrock-provider.fixture.js";
import { transportApp } from "../transport/transport-app.js";
import { StreamApplication, StreamCostApplication } from "./http-streaming.fixture.js";
import { plainOf, sseServer, streamOf, type SseServer } from "./sse-server.js";

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const USAGE = { prompt_tokens: 120_000, completion_tokens: 30_000, total_tokens: 150_000 };

/** The run's spend with `onStream` (streamed) and without (a plain call), on the same usage. */
async function spendOf(
  application: typeof StreamApplication,
  usage: Record<string, number>,
  streamed: boolean,
) {
  const server = await sseServer(
    [streamOf(["Hello", " there"], usage)],
    plainOf("Hello there", usage),
  );
  servers.push(server);
  const app = await transportApp(application, {
    client: new ScriptedBedrockClient([]),
    send: server.send,
  });
  const done = await execute(
    app,
    ChatStart,
    { text: "hi" },
    streamed ? { onStream: () => undefined } : undefined,
  );
  await app.close();
  return { done, requests: server.requests };
}

describe("#1005 AC1: a streamed call costs and counts what the plain call does", () => {
  it("AC1: tokens × the price table — the same spend and tokens, streamed or not", async () => {
    const streamed = await spendOf(StreamApplication, USAGE, true);
    const plain = await spendOf(StreamApplication, USAGE, false);

    expect(streamed.requests[0]?.body.stream).toBe(true);
    expect(plain.requests[0]?.body.stream).toBe(false);
    expect(streamed.done.spend.totalUsd).toBeCloseTo(0.18, 9); // 0.12 in + 0.06 out
    expect(streamed.done.spend).toEqual(plain.done.spend);
    expect(streamed.done.output).toEqual(plain.done.output);
  });

  it("AC1: the cost a provider reports (usage.cost) survives the chunks, to the cent of the plain call", async () => {
    const usage = { ...USAGE, cost: 0.0421 };
    const streamed = await spendOf(StreamCostApplication, usage, true);
    const plain = await spendOf(StreamCostApplication, usage, false);

    expect(streamed.done.spend.totalUsd).toBeCloseTo(0.0421, 9);
    expect(streamed.done.spend).toEqual(plain.done.spend);
  });
});
