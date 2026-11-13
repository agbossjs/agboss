/**
 * #956 — a provider's `chat()` called directly, before anything loaded the OpenAI client (a user's
 * own test, a provider subclass), behaves as the client itself did before the client became lazy:
 * every scenario runs on that lazy model and on a `ChatOpenAI` made as `chat()` made it before, on
 * one fake HTTP server, and the wire bodies, the outputs and what a tracer sees are compared.
 */
import { createServer, type Server } from "node:http";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedModelSettings } from "../../src/config/types.js";
import type { ChatRequest } from "../../src/models/handler.js";
import {
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  type NoRequestFields,
} from "../../src/models/index.js";
import { wireFetch } from "../../src/models/wire.js";

const settings: ResolvedModelSettings = { model: "gpt-4o-mini", temperature: 0, maxTokens: 50 };
const ANSWER = '{"answer":"yes"}';
const bodies: Record<string, unknown>[] = [];
let server: Server;
let baseUrl = "";

const delta = (fields: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: fields, finish_reason: finish }] })}\n\n`;

/** An OpenAI-compatible server: tool calls when the request has tools, else JSON text; streams too. */
function reply(body: Record<string, unknown>): { type: string; text: string } {
  const withTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (body.stream === true) {
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    const last = `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage })}\n\n`;
    return {
      type: "text/event-stream",
      text: `${delta({ role: "assistant", content: "po" })}${delta({ content: "ng" }, "stop")}${last}data: [DONE]\n\n`,
    };
  }
  const message = withTools
    ? {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: ANSWER } }],
      }
    : { role: "assistant", content: ANSWER };
  return {
    type: "application/json",
    text: JSON.stringify({
      id: "r",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const body: Record<string, unknown> = JSON.parse(raw);
      bodies.push(body);
      const answer = reply(body);
      response.setHeader("content-type", answer.type);
      response.end(answer.text);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? String(address.port) : "0"}/v1`;
});

afterAll(() => {
  server.close();
});

class Local extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

const requestOf = (): ChatRequest => ({
  settings,
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  connection: { provider: "local", baseUrl, apiKey: undefined, fetch },
});

/** What `chat()` made before the client became lazy: a `ChatOpenAI` over the same wire. */
function reference(): BaseChatModel {
  const request = requestOf();
  return new ChatOpenAI({
    apiKey: "none",
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: 50,
    maxRetries: 0,
    configuration: {
      baseURL: baseUrl,
      fetch: wireFetch(new Local().wirePlanOf(request), fetch),
      defaultHeaders: { "X-Title": "AGBoss" },
    },
  });
}

/** `chat()` of a fresh module graph: nothing has loaded the client, so it is the lazy model. */
async function direct(): Promise<BaseChatModel> {
  vi.resetModules();
  const { OpenAiCompatibleProvider: Fresh } = await import("../../src/models/index.js");
  class FreshLocal extends Fresh {
    override readonly requestFields: NoRequestFields = {};
  }
  return new FreshLocal().chat(requestOf());
}

/** What a tracer is told of one call of the model: its start and its end. */
async function traced(
  model: BaseChatModel,
  call: (model: BaseChatModel, options: object) => Promise<unknown>,
) {
  const seen: Record<string, any>[] = [];
  const callbacks = [
    {
      handleChatModelStart: (
        llm: { id: string[] },
        _messages: unknown,
        _run: string,
        _parent: string | undefined,
        extra: { invocation_params?: unknown } | undefined,
        _tags: unknown,
        metadata: Record<string, unknown> | undefined,
      ) =>
        seen.push({
          llm: llm.id.at(-1),
          params: extra?.invocation_params,
          model: metadata?.ls_model_name,
          temperature: metadata?.ls_temperature,
          maxTokens: metadata?.ls_max_tokens,
        }),
      handleLLMEnd: (output: {
        llmOutput?: unknown;
        generations: { generationInfo?: unknown }[][];
      }) =>
        seen.push({
          llmOutput: output.llmOutput,
          finish: output.generations[0]?.[0]?.generationInfo,
        }),
    },
  ];
  await call(model, { callbacks });
  return seen;
}

const Answer = z.object({ answer: z.string() });
const lookup = {
  type: "function",
  function: { name: "t", description: "d", parameters: { type: "object", properties: {} } },
};

/** Call options of the OpenAI client, which the base call options do not name. */
const perCall = (options: object): object => options;

type Scenario = (model: BaseChatModel) => Promise<unknown>;

/** The wire body of the call and the call's own result, as plain JSON. */
async function observed(model: BaseChatModel, run: Scenario) {
  const before = bodies.length;
  const result = await run(model);
  return { wire: bodies.slice(before), result: JSON.parse(JSON.stringify(result ?? null)) };
}

async function sameAsBefore(run: Scenario) {
  const expected = await observed(reference(), run);
  const lazy = await direct();
  const actual = await observed(lazy, run);

  expect(lazy._llmType()).toBe("agboss-lazy");
  expect(actual).toEqual(expected);
  return expected;
}

const struct =
  (config?: object): Scenario =>
  (model) =>
    model.withStructuredOutput(Answer, config).invoke("ping");

describe("#956: a chat() made before the client is loaded is the client's own (compared with ChatOpenAI)", () => {
  it("withStructuredOutput, default method", async () => {
    const { result } = await sameAsBefore(struct());

    expect(result).toEqual({ answer: "yes" });
  });

  it("withStructuredOutput, functionCalling", async () => {
    const { wire } = await sameAsBefore(struct({ method: "functionCalling" }));

    expect(wire[0]).toHaveProperty("tool_choice");
  });

  it("withStructuredOutput, jsonSchema", async () => {
    const { wire } = await sameAsBefore(struct({ method: "jsonSchema" }));

    expect(wire[0]).toHaveProperty("response_format");
  });

  it("withStructuredOutput, includeRaw", async () => {
    const { result } = await sameAsBefore(struct({ includeRaw: true }));

    expect(result.parsed).toEqual({ answer: "yes" });
  });

  it("per-call tools and tool_choice", async () => {
    const { wire } = await sameAsBefore((model) =>
      model.invoke("ping", perCall({ tools: [lookup], tool_choice: "required" })),
    );

    expect(wire[0]).toMatchObject({ tool_choice: "required" });
  });

  it("per-call response_format", async () => {
    const { wire } = await sameAsBefore((model) =>
      model.invoke("ping", perCall({ response_format: { type: "json_object" } })),
    );

    expect(wire[0]).toMatchObject({ response_format: { type: "json_object" } });
  });

  it("per-call parallel_tool_calls with bound tools", async () => {
    const { wire, result } = await sameAsBefore((model) =>
      traced(model, (m, o) =>
        (m.bindTools?.([lookup], perCall({ parallel_tool_calls: false })) ?? m).invoke("ping", o),
      ),
    );

    expect(wire[0]).toMatchObject({ parallel_tool_calls: false });
    expect(result[0].params).toMatchObject({ parallel_tool_calls: false });
  });

  it("a tracer sees the client: its name, its invocation params, usage and the finish reason", async () => {
    const { result } = await sameAsBefore((model) => traced(model, (m, o) => m.invoke("ping", o)));

    expect(result[0]).toMatchObject({ llm: "ChatOpenAI", model: "gpt-4o-mini" });
    expect(result[1].llmOutput.tokenUsage).toMatchObject({ totalTokens: 7 });
  });

  it("a stream: the chunks, their ids and the usage chunk", async () => {
    const { result } = await sameAsBefore(async (model) => {
      const chunks: unknown[] = [];
      for await (const chunk of await model.stream("ping")) chunks.push(chunk);
      return chunks;
    });

    expect(result.length).toBeGreaterThan(1);
  });
});
