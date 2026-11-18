import { HumanMessage, type AIMessageChunk } from "@langchain/core/messages";
import { afterEach, describe, expect, it } from "vitest";
import { SERVED_BY_FIELD } from "../../../src/finops/served-by.js";
import { loadChatOpenAI, loadedChatOpenAI } from "../../../src/models/chat-openai.js";
import { StreamAsker, clientOn } from "./streamed-client.js";
import { chunk, sseEvents, sseServer, type SseScript, type SseServer } from "./sse-server.js";
import { UsageShape, WIRE_HOST, WIRE_USAGE, streamWithUsage } from "./usage-shapes.js";

/**
 * #1231: the streamed client's chunks, one by one — only LangChain's usage chunk, the last one,
 * keeps a usage (the provider's last report); every other chunk's usage is empty, the rest of its
 * metadata stays.
 */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function clientFor(script: SseScript) {
  const server = await sseServer([script]);
  servers.push(server);
  return clientOn(server);
}

/** Every chunk the client yields for `script`, and their merge (the answer). */
async function chunksOf(script: SseScript) {
  const client = await clientFor(script);
  const chunks: AIMessageChunk[] = [];
  for await (const each of await client.stream("hi")) chunks.push(each);
  const [first, ...rest] = chunks;
  if (first === undefined) throw new Error("no chunk");
  return { chunks, answer: rest.reduce((merged, next) => merged.concat(next), first) };
}

/** A chunk with a usage report in it (LangChain gives a chunk without one `usage: {}`). */
const hasUsage = (message: AIMessageChunk): boolean =>
  Object.keys(message.response_metadata.usage ?? {}).length > 0;

const NO_USAGE: SseScript = {
  steps: [
    sseEvents(chunk({ role: "assistant", content: "" }), chunk({ content: "Hello" })),
    sseEvents(
      { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ),
  ],
};

describe("#1231: a streamed answer's usage, chunk by chunk", () => {
  it.each(Object.values(UsageShape))(
    "%s: only the last chunk has a usage — the wire's last report, its host once",
    async (shape) => {
      const { chunks, answer } = await chunksOf(streamWithUsage(["Hel", "lo"], shape));

      expect(chunks.filter(hasUsage)).toHaveLength(1);
      expect(chunks.at(-1)?.response_metadata.usage).toEqual({
        ...WIRE_USAGE,
        [SERVED_BY_FIELD]: WIRE_HOST,
      });
      expect(answer.response_metadata.usage).toEqual({
        ...WIRE_USAGE,
        [SERVED_BY_FIELD]: WIRE_HOST,
      });
      expect(answer.content).toBe("Hello");
      expect(answer.usage_metadata).toMatchObject({
        input_tokens: WIRE_USAGE.prompt_tokens,
        output_tokens: WIRE_USAGE.completion_tokens,
      });
    },
  );

  it("every other field of a chunk's metadata stays: the provider kind beside the finish reason", async () => {
    const { chunks, answer } = await chunksOf(streamWithUsage(["Hel", "lo"], UsageShape.OwnChunk));

    const texts = chunks.filter((each) => each.content !== "");
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.map((each) => each.response_metadata.model_provider)).toEqual(
      texts.map(() => "openai"),
    );
    expect(answer.response_metadata).toMatchObject({
      model_provider: "openai",
      finish_reason: "stop",
    });
  });

  it("a stream that reports no usage gets none: no chunk, and no answer, has a usage", async () => {
    const { chunks, answer } = await chunksOf(NO_USAGE);

    expect(chunks.filter(hasUsage)).toEqual([]);
    expect(answer.response_metadata.usage).toEqual({});
    expect(answer.content).toBe("Hello");
  });

  it("the usage chunk adds no text: a streamed generation's text is the answer's", async () => {
    const client = await clientFor(streamWithUsage(["Hel", "lo"], UsageShape.OnFinishChoice));

    const result = await client.generate([[new HumanMessage("hi")]], {
      callbacks: [new StreamAsker()],
    });

    expect(result.generations[0]?.[0]?.text).toBe("Hello");
  });

  it("the client keeps the OpenAI client's name, for traces and logs; once loaded it is at hand", async () => {
    const Client = await loadChatOpenAI();

    expect(Client.name).toBe("ChatOpenAI");
    expect(loadedChatOpenAI()).toBe(Client);
  });
});
