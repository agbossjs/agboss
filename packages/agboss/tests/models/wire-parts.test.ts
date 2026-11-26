/**
 * #899 §2: a file in a message is written as the wire has it in one place (`toWireRequest`) — an
 * image as `image_url`, a PDF as `file` — and read back by the real OpenAI client; the cache
 * markers keep to the provider's ceiling with files in the request.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { connectionOf } from "../../src/models/connections.js";
import { blockOfPart, contentOf } from "../../src/models/content.js";
import { ModelCallError, PromptCaching, Reasoning } from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { CachedPart, CacheRetention } from "../../src/models/prompt-caching.js";
import {
  MAX_CACHE_MARKERS,
  toWireRequest,
  type WireMessage,
  type WirePlan,
} from "../../src/models/wire.js";
import { ENV } from "./gateway.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";
import { handlerOf } from "./driver-handler.js";
import { completion, providerStub } from "./stub.js";

const IMAGE = { kind: "image", mediaType: "image/png", data: "AAAA", detail: "low" } as const;
const PDF = {
  kind: "file",
  mediaType: "application/pdf",
  filename: "a.pdf",
  data: "BBBB",
} as const;

/** What the real OpenAI client sends for one call with these messages. */
async function sentFor(messages: readonly (HumanMessage | SystemMessage)[]) {
  const stub = providerStub([completion()]);
  const provider = handlerOf(TestOpenRouterProvider);
  const connection = connectionOf(modelProviderOf(TestOpenRouterProvider), {
    env: ENV,
    requireKeys: true,
    send: stub.fetch,
  });
  const model = provider.chat({
    settings: { model: "moonshotai/kimi-k2.6", temperature: 0, maxTokens: 100 },
    reasoning: Reasoning.modelDecides(),
    promptCaching: PromptCaching.off(),
    connection,
  });
  await model.invoke([...messages]);
  return stub.requests[0]?.body ?? {};
}

describe("AC1: the exact wire JSON through ChatOpenAI", () => {
  it("AC1: an image and a PDF part go out as image_url and file, the text beside them as text", async () => {
    const body = await sentFor([
      new SystemMessage("rules"),
      new HumanMessage({
        content: [{ type: "text", text: "look" }, blockOfPart(IMAGE), blockOfPart(PDF)],
      }),
    ]);

    expect(body.messages).toEqual([
      { role: "system", content: "rules" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } },
          {
            type: "file",
            file: { filename: "a.pdf", file_data: "data:application/pdf;base64,BBBB" },
          },
        ],
      },
    ]);
  });

  it("AC2: a message without parts goes out as a plain string, byte for byte as before", async () => {
    const body = await sentFor([new SystemMessage("rules"), new HumanMessage("hi")]);

    expect(body.messages).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
    ]);
    expect(contentOf("hi", [])).toBe("hi");
  });

  it("AC6: an audio and a video part go out as input_audio (raw base64 and its format) and video_url", async () => {
    const body = await sentFor([
      new HumanMessage({
        content: [
          blockOfPart({ kind: "audio", mediaType: "audio/mpeg", data: "CCCC" }),
          blockOfPart({ kind: "audio", mediaType: "audio/x-wav", data: "DDDD" }),
          blockOfPart({ kind: "audio", mediaType: "audio/wav", data: "WWWW" }),
          blockOfPart({ kind: "audio", mediaType: "audio/mp4", data: "EEEE" }),
          blockOfPart({ kind: "video", mediaType: "video/mp4", data: "FFFF" }),
        ],
      }),
    ]);

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: "CCCC", format: "mp3" } },
          { type: "input_audio", input_audio: { data: "DDDD", format: "wav" } },
          { type: "input_audio", input_audio: { data: "WWWW", format: "wav" } },
          { type: "input_audio", input_audio: { data: "EEEE", format: "m4a" } },
          { type: "video_url", video_url: { url: "data:video/mp4;base64,FFFF" } },
        ],
      },
    ]);
  });

  it("AC6: an audio format the wire does not name (amr) is model.unsupported-input before any request", async () => {
    const audio = { kind: "audio", mediaType: "audio/amr", data: "CCCC" } as const;
    const failure = await sentFor([new HumanMessage({ content: [blockOfPart(audio)] })]).catch(
      (error: unknown) => error,
    );

    const refusals: ModelCallError[] = [];
    for (let cause: unknown = failure; cause instanceof Error; cause = cause.cause)
      if (cause instanceof ModelCallError) refusals.push(cause);
    expect(refusals[0]).toMatchObject({
      code: "model.unsupported-input",
      kind: "audio",
      mediaType: "audio/amr",
      model: "moonshotai/kimi-k2.6",
    });
  });
});

const PLAN: WirePlan = {
  fields: {},
  cacheMarkers: [CachedPart.SystemPrompt, CachedPart.History],
  cacheControl: { type: "ephemeral" },
};

const withFile = (role: string): WireMessage => ({
  role,
  content: [
    { type: "text", text: role },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ],
});

const marked = (messages: readonly WireMessage[] | undefined): number[] =>
  (messages ?? []).flatMap((message, index) =>
    typeof message.content !== "string" &&
    (message.content ?? []).some((part) => part.cache_control !== undefined)
      ? [index]
      : [],
  );

describe("prompt caching with files in the request", () => {
  it("the message holding files is marked even as the last user message", () => {
    const wire = toWireRequest(
      { model: "m", messages: [{ role: "system", content: "s" }, withFile("user")] },
      PLAN,
    );

    expect(marked(wire.messages)).toEqual([0, 1]);
  });

  it("five tool-result file messages stay at four markers, the newest kept", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "s" },
      ...[1, 2, 3, 4, 5].map(() => withFile("user")),
    ];

    const wire = toWireRequest({ model: "m", messages }, PLAN);

    expect(marked(wire.messages)).toHaveLength(MAX_CACHE_MARKERS);
    expect(marked(wire.messages)).toEqual([0, 3, 4, 5]);
  });

  it("with caching off no file message is marked", () => {
    const off: WirePlan = { ...PLAN, cacheMarkers: [] };

    const wire = toWireRequest(
      { model: "m", messages: [{ role: "system", content: "s" }, withFile("user")] },
      off,
    );

    expect(marked(wire.messages)).toEqual([]);
    expect(CacheRetention.FiveMinutes).toBe("5m");
  });
});
