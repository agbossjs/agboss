import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Cassette } from "../../src/testing/vcr-cassette.js";
import { readCassette, CASSETTE_VERSION } from "../../src/testing/vcr-file.js";
import { VcrChatModel } from "../../src/testing/vcr-chat-model.js";
import { StreamAsker, clientOn } from "../models/streaming/streamed-client.js";
import { plainOf, sseServer, streamOf, type SseServer } from "../models/streaming/sse-server.js";

/**
 * #1005: a VCR recording made over a streamed HTTP call keeps the cassette's version 2 format and
 * the reply's `usage.cost`; a replay needs neither the stream nor the network.
 */

const dir = mkdtempSync(join(tmpdir(), "vcr-streamed-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const hashes = { of: (key: string) => ({ component: key }), knows: () => true };
const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0421 };

/** One recorded call of the real client on a local server, streamed or plain. */
async function recorded(file: string, streamed: boolean) {
  const server = await sseServer([streamOf(["Hel", "lo"], usage)], plainOf("Hello", usage));
  servers.push(server);
  const real = await clientOn(server);
  const cassette = Cassette.recording(file, hashes);
  const model = new VcrChatModel(cassette, "agent:echo", "stream/model", () => real);
  const asker = new StreamAsker();
  // the run's callbacks reach the real model through async local storage, as a graph's do
  const call = () => model.invoke("hi");
  const answer = await (streamed
    ? AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: [asker] }, call)
    : call());
  return { answer, asker, requests: server.requests, cassette };
}

describe("#1005: the VCR records a streamed HTTP call in the unchanged format", () => {
  it("a recording made over a stream is a version 2 cassette with the reply's usage and cost", async () => {
    const file = join(dir, "streamed.json");

    const { answer, requests } = await recorded(file, true);

    expect(requests[0]?.body.stream).toBe(true);
    const content = readCassette(file);
    expect(content.version).toBe(CASSETTE_VERSION);
    expect(content.interactions).toHaveLength(1);
    const [interaction] = content.interactions;
    if (interaction?.kind !== "chat") throw new Error("a chat interaction");
    expect(interaction.key).toBe("agent:echo");
    expect(interaction.component).toBe("agent:echo");
    expect(interaction.reply.content).toBe("Hello");
    expect(interaction.reply.usage_metadata).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(interaction.reply.response_metadata?.usage).toMatchObject({ cost: 0.0421 });
    expect(answer.text).toBe("Hello");
  });

  it("the streamed recording replays as the plain one does: the same reply, token counts and cost", async () => {
    const plainFile = join(dir, "plain.json");
    const streamedFile = join(dir, "streamed-2.json");
    await recorded(plainFile, false);
    await recorded(streamedFile, true);

    const reply = (file: string) => {
      const [interaction] = readCassette(file).interactions;
      if (interaction?.kind !== "chat") throw new Error("a chat interaction");
      return interaction.reply;
    };
    const plain = reply(plainFile);
    const streamed = reply(streamedFile);

    expect(streamed.content).toEqual(plain.content);
    expect(streamed.tool_calls).toEqual(plain.tool_calls);
    expect(streamed.usage_metadata).toMatchObject({
      input_tokens: plain.usage_metadata?.input_tokens,
      output_tokens: plain.usage_metadata?.output_tokens,
    });
    expect(streamed.response_metadata?.usage).toMatchObject({ cost: 0.0421 });
    expect(streamed.response_metadata?.finish_reason).toBe(plain.response_metadata?.finish_reason);
  });
});
