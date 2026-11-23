/**
 * #1366: the transport's messages: a file part is carried in `parts` and never as text, an unsupported block or a
 * role-less message is refused with ModelProviderError, tool calls and tool-call ids appear only where they belong;
 * a provider's answer is accepted only with text and numeric usage, and its token details, cost and finish reason
 * reach the AIMessage exactly as stated (cache tokens default to 0, nothing is invented for cost or finish reason).
 */
import {
  AIMessage,
  ChatMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { ModelProviderError, ModelProviderMessageRole } from "../../../src/models/index.js";
import {
  aiMessageOf,
  providerMessagesOf,
  toolDefinitionsOf,
} from "../../../src/models/transport/messages.js";

const P = "prov";
const filePart = {
  type: "agboss_part",
  kind: "file",
  mediaType: "application/pdf",
  data: "QQ==",
  filename: "a.pdf",
};

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("#1366: providerMessagesOf", () => {
  it("carries a file part in parts and keeps it out of the text", () => {
    const [m] = providerMessagesOf(
      [
        new HumanMessage({
          content: [{ type: "text", text: "see " }, filePart, { type: "text", text: "this" }],
        }),
      ],
      P,
    );
    expect(m).toStrictEqual({
      role: ModelProviderMessageRole.User,
      text: "see this",
      parts: [{ kind: "file", mediaType: "application/pdf", data: "QQ==", filename: "a.pdf" }],
    });
  });

  it("refuses a block that is neither text nor a file part", () => {
    for (const block of [
      { type: "image_url", text: "x" },
      { type: "text" },
      { type: "text", text: 5 },
      { type: "foo" },
    ]) {
      const e = thrown(() => providerMessagesOf([new HumanMessage({ content: [block] })], P));
      expect(e).toBeInstanceOf(ModelProviderError);
    }
  });

  it("refuses a message without a transport role", () => {
    const e = thrown(() => providerMessagesOf([new ChatMessage("hi", "custom")], P));
    expect(e).toBeInstanceOf(ModelProviderError);
    expect((e as Error).message).not.toBe("");
  });

  it("adds no parts, toolCalls or toolCallId where there are none", () => {
    expect(
      providerMessagesOf([new SystemMessage("s"), new HumanMessage("h"), new AIMessage("a")], P),
    ).toStrictEqual([
      { role: ModelProviderMessageRole.System, text: "s" },
      { role: ModelProviderMessageRole.User, text: "h" },
      { role: ModelProviderMessageRole.Assistant, text: "a" },
    ]);
  });

  it("adds the tool calls of an assistant message and the call id of a tool message", () => {
    const out = providerMessagesOf(
      [
        new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "t", args: { a: 1 } }] }),
        new ToolMessage({ content: "r", tool_call_id: "c1" }),
      ],
      P,
    );
    expect(out).toStrictEqual([
      {
        role: ModelProviderMessageRole.Assistant,
        text: "",
        toolCalls: [{ id: "c1", name: "t", arguments: { a: 1 } }],
      },
      { role: ModelProviderMessageRole.Tool, text: "r", toolCallId: "c1" },
    ]);
  });

  it("keeps a file part on an assistant message with tool calls and on a tool message", () => {
    const out = providerMessagesOf(
      [
        new AIMessage({ content: [filePart], tool_calls: [{ id: "c", name: "t", args: {} }] }),
        new ToolMessage({ content: [filePart] as never, tool_call_id: "c" }),
      ],
      P,
    );
    for (const m of out) expect(m.parts).toHaveLength(1);
  });

  it("gives a tool call without an id the empty id, and a message without tool_calls none", () => {
    const noId = new AIMessage({ content: "", tool_calls: [{ name: "t", args: {} }] });
    expect(providerMessagesOf([noId], P)[0]?.toolCalls).toStrictEqual([
      { id: "", name: "t", arguments: {} },
    ]);
    const none = new AIMessage("x");
    none.tool_calls = undefined;
    expect(providerMessagesOf([none], P)[0]).toStrictEqual({
      role: ModelProviderMessageRole.Assistant,
      text: "x",
    });
  });
});

describe("#1366: toolDefinitionsOf", () => {
  it("states the description, or the empty one", () => {
    const out = toolDefinitionsOf([
      {
        type: "function",
        function: {
          name: "a",
          description: "does a",
          parameters: { type: "object", properties: {} },
        },
      },
      { type: "function", function: { name: "b", parameters: { type: "object", properties: {} } } },
    ]);
    expect(out.map((d) => [d.name, d.description])).toStrictEqual([
      ["a", "does a"],
      ["b", ""],
    ]);
  });
});

describe("#1366: aiMessageOf", () => {
  const ok = { text: "t", usage: { inputTokens: 2, outputTokens: 3 } };

  it("refuses an answer that lacks text or numeric usage", () => {
    const bads: unknown[] = [
      null,
      undefined,
      "x",
      5,
      {},
      { usage: ok.usage },
      { text: "t" },
      { text: "t", usage: null },
      { text: "t", usage: { outputTokens: 1 } },
      { text: "t", usage: { inputTokens: 1 } },
      { text: "t", usage: { inputTokens: "1", outputTokens: 1 } },
      { text: 5, usage: ok.usage },
    ];
    for (const b of bads)
      expect(thrown(() => aiMessageOf(b, "m", P))).toBeInstanceOf(ModelProviderError);
    expect((thrown(() => aiMessageOf(null, "m", P)) as Error).message).not.toBe("");
  });

  it("states tokens with cache details, defaulting them to 0", () => {
    const a = aiMessageOf(ok, "m", P);
    expect(a.usage_metadata).toStrictEqual({
      input_tokens: 2,
      output_tokens: 3,
      total_tokens: 5,
      input_token_details: { cache_read: 0, cache_creation: 0 },
    });
    const b = aiMessageOf(
      { ...ok, usage: { ...ok.usage, cacheReadTokens: 7, cacheWriteTokens: 9 } },
      "m",
      P,
    );
    expect(b.usage_metadata?.input_token_details).toStrictEqual({
      cache_read: 7,
      cache_creation: 9,
    });
  });

  it("invents no cost or finish reason", () => {
    expect(aiMessageOf(ok, "m", P).response_metadata).toStrictEqual({ model_name: "m", usage: {} });
    expect(
      aiMessageOf({ ...ok, cost: 0.5, finishReason: "stop" }, "m", P).response_metadata,
    ).toStrictEqual({
      model_name: "m",
      usage: { cost: 0.5 },
      finish_reason: "stop",
    });
  });
});
