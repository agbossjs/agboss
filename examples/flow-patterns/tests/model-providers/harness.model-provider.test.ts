import { describe, expect, it } from "vitest";
import { ModelProviderMessageRole, type ModelProviderRequest } from "@agboss/core/models";
import { HarnessModelProvider } from "../../src/model-providers/harness.model-provider.js";

describe("the transport provider answers by the request", () => {
  const request = (messages: ModelProviderRequest["messages"]): ModelProviderRequest => ({
    model: "harness/desk",
    messages,
    tools: [],
    temperature: 0,
    maxTokens: undefined,
    reasoning: { kind: "off" },
    promptCaching: { kind: "off" },
    signal: new AbortController().signal,
  });
  const provider = new HarnessModelProvider();

  it("first a lookup of the #order, then the tool's answer quoted", async () => {
    const first = await provider.complete(
      request([{ role: ModelProviderMessageRole.User, text: "Where is #7?" }]),
    );
    const second = await provider.complete(
      request([
        { role: ModelProviderMessageRole.User, text: "Where is #7?" },
        { role: ModelProviderMessageRole.Tool, text: "shipped", toolCallId: "call-1" },
      ]),
    );

    expect(first.toolCalls).toEqual([
      { id: "call-1", name: "order-status-tool", arguments: { orderId: "7" } },
    ]);
    expect(second.text).toBe("It says: shipped");
  });
});
