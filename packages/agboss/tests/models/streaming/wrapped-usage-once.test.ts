import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { afterEach, describe, expect, it } from "vitest";
import { SERVED_BY_FIELD } from "../../../src/finops/served-by.js";
import { recordUsage } from "../../../src/finops/usage.js";
import { loadChatOpenAI } from "../../../src/models/chat-openai.js";
import { StreamAsker, clientOn } from "./streamed-client.js";
import { sseServer, type SseServer } from "./sse-server.js";
import { UsageShape, WIRE_HOST, WIRE_USAGE, streamWithUsage } from "./usage-shapes.js";

/**
 * #1231 (acceptance H): whatever LangChain wraps the client in, a streamed call's usage is the
 * wire's, once — its cost, its tokens and its host — and its finish reason stays (#1005).
 * `bindTools` goes through `withConfig`, which in `@langchain/openai` makes a new plain
 * `ChatOpenAI`: a fix that lives in a subclass of the client is lost there, so the usage is taken
 * once where the client reads the wire — its fetch, which every copy of the client keeps.
 */

const servers: SseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const lookup = tool(() => "found", {
  name: "lookup-tool",
  description: "Looks a thing up",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { query: { type: "string" } },
  },
});

const VERDICT = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

type Answering = Runnable<BaseLanguageModelInput, AIMessageChunk>;

/** Every LangChain wrapper an answer may come through, alone and stacked; each answers a message. */
const WRAPPERS: readonly (readonly [string, (model: BaseChatModel) => Answering])[] = [
  ["the client itself", (model) => model],
  ["bindTools", (model) => bound(model)],
  ["withConfig", (model) => model.withConfig({ tags: ["wrapped"] })],
  ["withRetry", (model) => model.withRetry({ stopAfterAttempt: 1 })],
  ["withFallbacks", (model) => model.withFallbacks([model])],
  ["bindTools, then withConfig", (model) => bound(model).withConfig({ tags: ["wrapped"] })],
  ["bindTools, then withRetry", (model) => bound(model).withRetry({ stopAfterAttempt: 1 })],
  ["bindTools, then withFallbacks", (model) => bound(model).withFallbacks([bound(model)])],
];

function bound(model: BaseChatModel): Answering {
  if (model.bindTools === undefined) throw new Error("the client binds no tools");
  return model.bindTools([lookup]);
}

/** The client on a 127.0.0.1 server whose every answer streams in `shape`. */
async function modelOn(shape: UsageShape, tokens: readonly string[] = ["Hel", "lo"]) {
  const server = await sseServer([streamWithUsage(tokens, shape)]);
  servers.push(server);
  return clientOn(server);
}

/** The answer of `runnable` merged from its stream, as a caller that reads the stream merges it. */
async function streamedAnswer(runnable: Answering): Promise<AIMessageChunk> {
  let answer: AIMessageChunk | undefined;
  for await (const each of await runnable.stream("hi")) {
    answer = answer === undefined ? each : answer.concat(each);
  }
  if (answer === undefined) throw new Error("no chunk");
  return answer;
}

/** What AGBoss records of `message`: the wire's usage, once, and its host once. */
function expectWireUsageOnce(message: BaseMessage): void {
  expect(message.response_metadata).toMatchObject({
    usage: { ...WIRE_USAGE, [SERVED_BY_FIELD]: WIRE_HOST },
  });
  expect(Object.keys(Reflect.get(message.response_metadata, "usage") ?? {})).toHaveLength(
    Object.keys(WIRE_USAGE).length + 1,
  );
  expect(Reflect.get(message, "usage_metadata")).toMatchObject({
    input_tokens: WIRE_USAGE.prompt_tokens,
    output_tokens: WIRE_USAGE.completion_tokens,
  });
  expect(recordUsage("agent", { model: "stream/model" }, message)).toMatchObject({
    costUsd: WIRE_USAGE.cost,
    costSource: "api",
    inputTokens: WIRE_USAGE.prompt_tokens,
    outputTokens: WIRE_USAGE.completion_tokens,
    servedBy: WIRE_HOST,
  });
}

describe("#1231: a streamed call's usage is the wire's, once, through every LangChain wrapper", () => {
  describe.each(Object.values(UsageShape))("%s", (shape) => {
    it.each(WRAPPERS)(
      "%s, called with a streaming handler (an agent's answer): the usage once, the finish reason kept",
      async (_name, wrap) => {
        const asker = new StreamAsker();
        const message = await wrap(await modelOn(shape)).invoke("hi", { callbacks: [asker] });

        expect(asker.tokens.join("")).toBe("Hello");
        expect(message.content).toBe("Hello");
        expectWireUsageOnce(message);
        expect(message.response_metadata.finish_reason).toBe("stop");
      },
    );

    it.each(WRAPPERS)(
      "%s, its stream merged (a fallback's streamed call): the usage once",
      async (_name, wrap) => {
        const answer = await streamedAnswer(wrap(await modelOn(shape)));

        expect(answer.content).toBe("Hello");
        expectWireUsageOnce(answer);
      },
    );

    it("withStructuredOutput, its raw answer: the usage once", async () => {
      const model = await modelOn(shape, ['{"verdict":', '"guilty"}']);
      const structured = model.withStructuredOutput(VERDICT, { includeRaw: true });

      const { raw, parsed } = await structured.invoke("hi", { callbacks: [new StreamAsker()] });

      expect(parsed).toEqual({ verdict: "guilty" });
      expectWireUsageOnce(raw);
    });
  });

  it("bindTools and withConfig keep the client's class: what a subclass adds is not lost", async () => {
    const Client = await loadChatOpenAI();
    const model = await modelOn(UsageShape.OwnChunk);

    expect(model).toBeInstanceOf(Client);
    expect(bound(model)).toBeInstanceOf(Client);
    expect(model.withConfig({ tags: ["wrapped"] })).toBeInstanceOf(Client);
  });
});
