import { afterEach, describe, expect, it } from "vitest";
import { servedByOf } from "../../../src/finops/served-by.js";
import { isCutAtLimit } from "../../../src/models/finish-reason.js";
import { StreamAsker, clientOn } from "./streamed-client.js";
import { chunk, sseEvents, sseServer, type SseServer } from "./sse-server.js";

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function answerOf(steps: Parameters<typeof sseEvents>) {
  const server = await sseServer([{ steps: [sseEvents(...steps)] }]);
  servers.push(server);
  const asker = new StreamAsker();
  const message = await (await clientOn(server)).invoke("hi", { callbacks: [asker] });
  return { message, asker };
}

const finish = (reason: string, provider = "Acme"): Record<string, unknown> => ({
  ...chunk({}, provider),
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
});

describe("#1005 AC2: what a streamed answer keeps of its chunks", () => {
  it("the host stays across chunks: only the early chunks name it, the usage chunk does not", async () => {
    const { message } = await answerOf([
      chunk({ content: "a" }, "Acme"),
      chunk({ content: "b" }, "Acme"),
      finish("stop"),
      {
        id: "c",
        model: "m",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      "[DONE]",
    ]);

    expect(servedByOf(message.response_metadata)).toBe("Acme");
  });

  it("the host of the last chunk that names one wins (a provider that changed mid-stream)", async () => {
    const { message } = await answerOf([
      chunk({ content: "a" }, "First"),
      { ...chunk({ content: "b" }, "Second"), usage: null },
      finish("stop", "Second"),
      {
        id: "c",
        model: "m",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      "[DONE]",
    ]);

    expect(servedByOf(message.response_metadata)).toBe("Second");
  });

  it("a streamed answer cut at the limit says so: finish_reason survives the chunk merge", async () => {
    const { message } = await answerOf([
      chunk({ content: "cut of" }),
      finish("length"),
      {
        id: "c",
        model: "m",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      "[DONE]",
    ]);

    expect(isCutAtLimit(message)).toBe(true);
    expect(message.text).toBe("cut of");
  });

  it("a streamed tool call keeps its arguments, and no text is streamed for it", async () => {
    const { message, asker } = await answerOf([
      chunk({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "answer", arguments: '{"verdict"' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ':"yes"}' } }] }),
      finish("tool_calls"),
      {
        id: "c",
        model: "m",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      "[DONE]",
    ]);

    expect(message.tool_calls).toEqual([
      { name: "answer", args: { verdict: "yes" }, id: "call-1", type: "tool_call" },
    ]);
    expect(asker.tokens.join("")).toBe("");
  });
});
