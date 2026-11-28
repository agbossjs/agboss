/** #1048: the fallback model's streamed call — its tokens, its failure, the answer it marks. */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { fallbackMarkOf } from "../../../src/finops/fallback-mark.js";
import { EventStreamError } from "../../../src/models/calls/event-stream-guard.js";
import { ModelCost } from "../../../src/models/cost.js";
import {
  markedChunk,
  presentFields,
  streamedAnswer,
  type Told,
} from "../../../src/models/fallback-stream.js";
import { usd } from "../../../src/units/index.js";

class Tokens extends BaseCallbackHandler {
  name = "tokens";
  override awaitHandlers = true;
  readonly heard: string[] = [];
  override handleLLMNewToken(token: string): void {
    this.heard.push(token);
  }
}

const managerOf = (handler: Tokens): CallbackManagerForLLMRun =>
  new CallbackManagerForLLMRun("run-1", [handler], [], [], [], {}, {});

/** A chat model that streams `chunks` and keeps the call options it was given. */
class Chunks extends FakeStreamingChatModel {
  readonly seen: { signal: AbortSignal | undefined; callbacks: number }[] = [];
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.seen.push({ signal: options.signal, callbacks: runManager?.handlers.length ?? 0 });
    if (this.chunks.length === 0) return; // a server that streams nothing
    yield* super._streamResponseChunks(messages, options, runManager);
  }
}

function modelOf(chunks: readonly AIMessageChunk[]) {
  const model = new Chunks({ chunks: [...chunks] });
  return { model, seen: model.seen };
}

const MESSAGES = [new HumanMessage("hi")];
const chunkOf = (content: string): AIMessageChunk => new AIMessageChunk({ content });

describe("streamedAnswer", () => {
  it("tells each non-empty token to the run, joins the chunks, and notes that text went out", async () => {
    const tokens = new Tokens();
    const told: Told = { text: false, chars: 0 };
    const { model } = modelOf([chunkOf("Hel"), chunkOf(""), chunkOf("lo")]);

    const answer = await streamedAnswer(model, MESSAGES, managerOf(tokens), undefined, told);

    expect(tokens.heard).toEqual(["Hel", "lo"]);
    expect(answer.text).toBe("Hello");
    expect(told.text).toBe(true);
  });

  it("counts the characters of every chunk it told, so a call that fails later is billed for them", async () => {
    const told: Told = { text: false, chars: 0 };
    const { model } = modelOf([chunkOf("Hel"), chunkOf(""), chunkOf("lo!")]);

    await streamedAnswer(model, MESSAGES, undefined, undefined, told);

    expect(told.chars).toBe(6);
  });

  it("adds to what an earlier part of the call had told", async () => {
    const told: Told = { text: true, chars: 10 };
    const { model } = modelOf([chunkOf("abc")]);

    await streamedAnswer(model, MESSAGES, undefined, undefined, told);

    expect(told.chars).toBe(13);
  });

  it("an answer of empty chunks told no text", async () => {
    const tokens = new Tokens();
    const told: Told = { text: false, chars: 0 };
    const { model } = modelOf([chunkOf("")]);

    await streamedAnswer(model, MESSAGES, managerOf(tokens), undefined, told);

    expect(tokens.heard).toEqual([]);
    expect(told.text).toBe(false);
  });

  it("works without a run manager", async () => {
    const told: Told = { text: false, chars: 0 };
    const { model } = modelOf([chunkOf("x")]);

    const answer = await streamedAnswer(model, MESSAGES, undefined, undefined, told);

    expect(answer.text).toBe("x");
    expect(told.text).toBe(true);
  });

  it("calls the model untraced, with the caller's signal", async () => {
    const controller = new AbortController();
    const { model, seen } = modelOf([chunkOf("x")]);

    await streamedAnswer(model, MESSAGES, undefined, controller.signal, { text: false, chars: 0 });
    controller.abort();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.callbacks).toBe(0);
    expect(seen[0]?.signal?.aborted).toBe(true); // the caller's abort reaches the model's call
  });

  it("a call without a signal has none", async () => {
    const { model, seen } = modelOf([chunkOf("x")]);

    await streamedAnswer(model, MESSAGES, undefined, undefined, { text: false, chars: 0 });

    expect(seen[0]?.signal).toBeUndefined();
  });

  it("a model that streams nothing is a failed call of the provider, not a configuration error", async () => {
    const { model } = modelOf([]);

    const failure = await streamedAnswer(model, MESSAGES, undefined, undefined, {
      text: false,
      chars: 0,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EventStreamError);
    expect(failure).toHaveProperty("message", "the model answered nothing");
  });
});

describe("markedChunk with no earlier providers", () => {
  it("leaves no earlier share in the mark when none is given", () => {
    const marked = markedChunk(chunkOf("t"), {
      provider: "backup-provider",
      model: "backup/m",
      cost: undefined,
    });
    expect(fallbackMarkOf(marked.response_metadata)?.earlier).toEqual([]);
  });
});

describe("markedChunk", () => {
  const cost = ModelCost.fromPrices({
    "backup/m": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  });

  it("keeps the content, calls, usage and id, and marks the model and its price", () => {
    const answer = new AIMessageChunk({
      content: "text",
      id: "msg-1",
      tool_calls: [{ id: "c1", name: "f", args: { a: 1 }, type: "tool_call" }],
      usage_metadata: { input_tokens: 1_000_000, output_tokens: 500_000, total_tokens: 1_500_000 },
      additional_kwargs: { k: "v" },
      response_metadata: { finish_reason: "stop" },
    });

    const marked = markedChunk(answer, { provider: "backup-provider", model: "backup/m", cost });

    expect(marked).toBeInstanceOf(AIMessageChunk);
    expect(marked.content).toBe("text");
    expect(marked.id).toBe("msg-1");
    expect(marked.tool_calls).toEqual([{ id: "c1", name: "f", args: { a: 1 }, type: "tool_call" }]);
    expect(marked.usage_metadata).toEqual({
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      total_tokens: 1_500_000,
    });
    expect(marked.additional_kwargs).toEqual({ k: "v" });
    expect(marked.response_metadata).toMatchObject({
      finish_reason: "stop",
      usage: {
        cost: 2,
        agboss_fallback: { provider: "backup-provider", model: "backup/m", priced: true },
      },
    });
  });

  it("an answer without id, usage or calls has none of them after", () => {
    const marked = markedChunk(chunkOf("t"), {
      provider: "backup-provider",
      model: "backup/m",
      cost,
    });

    expect(marked.id).toBeUndefined();
    expect(marked.usage_metadata).toBeUndefined();
    expect(marked.tool_calls).toEqual([]);
    expect(marked.text).toBe("t");
  });
});

describe("presentFields (#1353)", () => {
  it("drops the fields that are undefined and keeps the others, falsy ones too", () => {
    const fields = presentFields({ a: 1, b: undefined, c: 0, d: "", e: false, f: null });
    expect(fields).toStrictEqual({ a: 1, c: 0, d: "", e: false, f: null });
    expect("b" in fields).toBe(false);
  });

  it("gives nothing for fields that are all undefined", () => {
    expect(presentFields({ a: undefined })).toStrictEqual({});
  });
});
