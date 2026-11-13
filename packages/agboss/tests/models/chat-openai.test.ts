import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@langchain/openai");
  vi.resetModules();
});

describe("the OpenAI chat client loads on demand (#956)", () => {
  it("is not available before it is loaded", async () => {
    vi.resetModules();
    const { chatOpenAIClass } = await import("../../src/models/chat-openai.js");

    expect(() => chatOpenAIClass()).toThrow("await loadChatOpenAI() first");
  });

  it("a failed load leaves nothing behind: the next call loads it", async () => {
    vi.resetModules();
    vi.doMock("@langchain/openai", () => {
      throw new Error("broken install");
    });
    const { loadChatOpenAI, chatOpenAIClass } = await import("../../src/models/chat-openai.js");

    await expect(loadChatOpenAI()).rejects.toThrow();
    expect(() => chatOpenAIClass()).toThrow("not loaded");

    vi.doUnmock("@langchain/openai");
    vi.resetModules();
    const retry = await import("../../src/models/chat-openai.js");
    await retry.loadChatOpenAI();

    expect(typeof retry.chatOpenAIClass()).toBe("function");
  });
});
