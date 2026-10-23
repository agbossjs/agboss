/**
 * #385 — the transport's parts on their own: LangChain's messages as `ModelProviderMessage`s (text
 * only), the answer's shape checked, `ModelProviderFailureError`, the late container binding, and a
 * gateway without the lazily loaded transport chat models.
 */
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { lateTransports } from "../../../src/app/late-transports.js";
import { providerClients, ProviderCapabilityError } from "../../../src/llm/provider-clients.js";
import {
  FinishReason,
  ModelFailure,
  ModelProviderDirectory,
  ModelProviderError,
  ModelProviderFailureError,
  ModelProviderMessageRole,
} from "../../../src/models/index.js";
import { aiMessageOf, providerMessagesOf } from "../../../src/models/transport/messages.js";
import { transportSnapshot } from "../../../src/run/transport-snapshot.js";
import { seconds } from "../../../src/units/index.js";
import { ENV, KEYS } from "../gateway.js";
import { BedrockModelProvider } from "./bedrock-provider.fixture.js";

describe("#385: the transport's messages", () => {
  it("system, user, assistant with its tool calls and the tool's result, in order", () => {
    const messages = providerMessagesOf(
      [
        new SystemMessage("Be brief."),
        new HumanMessage([
          { type: "text", text: "where is " },
          { type: "text", text: "7?" },
        ]),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c1", name: "order-status-tool", args: { orderId: "7" } }],
        }),
        new ToolMessage({ content: "shipped", tool_call_id: "c1" }),
      ],
      "bedrock-model-provider",
    );

    expect(messages).toEqual([
      { role: ModelProviderMessageRole.System, text: "Be brief." },
      { role: ModelProviderMessageRole.User, text: "where is 7?" },
      {
        role: ModelProviderMessageRole.Assistant,
        text: "",
        toolCalls: [{ id: "c1", name: "order-status-tool", arguments: { orderId: "7" } }],
      },
      { role: ModelProviderMessageRole.Tool, text: "shipped", toolCallId: "c1" },
    ]);
  });

  it("an image part cannot be carried: a ModelProviderError names the provider", () => {
    const image = new HumanMessage([{ type: "image_url", image_url: { url: "data:," } }]);

    expect(() => providerMessagesOf([image], "bedrock-model-provider")).toThrow(
      'bedrock-model-provider: a transport provider carries text only, not a "image_url" part',
    );
  });

  it("the answer: text, tool calls, usage, cost and the finish reason on the message", () => {
    const message = aiMessageOf(
      {
        text: "cut",
        toolCalls: [{ id: "c1", name: "t", arguments: { a: 1 } }],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 },
        cost: 0.01,
        finishReason: FinishReason.Length,
      },
      "bedrock/claude",
      "bedrock-model-provider",
    );

    expect(message.tool_calls).toEqual([
      { id: "c1", name: "t", args: { a: 1 }, type: "tool_call" },
    ]);
    expect(message.usage_metadata).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    expect(message.response_metadata).toMatchObject({
      usage: { cost: 0.01 },
      finish_reason: "length",
      model_name: "bedrock/claude",
    });
  });

  it("an answer without text or usage is the project's mistake: a ModelProviderError, never a guess", () => {
    expect(() =>
      aiMessageOf({ text: "no usage" }, "bedrock/claude", "bedrock-model-provider"),
    ).toThrow(ModelProviderError);
  });
});

describe("#385: its errors and its wiring", () => {
  it("ModelProviderFailureError carries its failure, retryAfter and cause, under a stable code", () => {
    const cause = new Error("ThrottlingException");
    const error = new ModelProviderFailureError(ModelFailure.RateLimited, {
      retryAfter: seconds(2),
      cause,
    });

    expect(error).toMatchObject({
      code: "model.provider-failure",
      failure: ModelFailure.RateLimited,
      retryAfter: 2000,
      cause,
      message: "model.provider-failure: rate-limited",
    });
    expect(new ModelProviderFailureError(ModelFailure.Timeout).retryAfter).toBeUndefined();
  });

  it("before the container is bound a transport cannot be created; after, the container gives it", () => {
    const transports = lateTransports();
    const instance = { complete: () => Promise.reject(new Error("unused")) };

    expect(() => transports.resolve(BedrockModelProvider)).toThrow(ModelProviderError);
    transports.bind(() => instance);
    expect(transports.resolve(BedrockModelProvider)).toBe(instance);
    transports.bind(() => undefined);
    expect(() => transports.resolve(BedrockModelProvider)).toThrow(
      "the container gave no provider instance",
    );
  });

  it("a gateway built without the transport chat models refuses a transport's model by name", () => {
    const clients = providerClients(ModelProviderDirectory.of([BedrockModelProvider]), {
      env: ENV,
      environment: KEYS,
    });

    expect(() =>
      clients.chatModel({ model: "bedrock/claude", temperature: 0, maxTokens: 1 }),
    ).toThrow(ProviderCapabilityError);
  });

  it("configHash's transports: only where there is one", () => {
    expect(transportSnapshot([])).toEqual({});
    expect(transportSnapshot([BedrockModelProvider])).toEqual({
      transports: [
        {
          name: "bedrock-model-provider",
          className: "BedrockModelProvider",
          serves: ["/^bedrock\\//"],
        },
      ],
    });
  });
});
