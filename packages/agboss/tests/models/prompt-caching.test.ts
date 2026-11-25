import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import {
  CachedPart,
  CacheRetention,
  PromptCaching,
  Reasoning,
  toWireRequest,
} from "../../src/models/index.js";
import { promptCachingLabel, promptCachingOfSetting } from "../../src/models/prompt-caching.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";
import { handlerOf } from "./driver-handler.js";
import { LocalModelProvider } from "./providers.fixture.js";
import { wireBodies } from "./gateway.js";

const claude = {
  model: "anthropic/claude-sonnet-4.5",
  modelProvider: "openrouter-model-provider",
  temperature: 0,
  maxTokens: 100,
};
const conversation = {
  model: "anthropic/claude-sonnet-4.5",
  messages: [
    { role: "system", content: "rules" },
    { role: "user", content: "first" },
    { role: "assistant", content: "earlier replyWith" },
    { role: "user", content: "second" },
  ],
};

const planFor = (caching: PromptCaching, model = "anthropic/claude-sonnet-4.5") =>
  handlerOf(TestOpenRouterProvider).wirePlanOf({
    settings: { model, modelProvider: "openrouter-model-provider", temperature: 0, maxTokens: 10 },
    reasoning: Reasoning.modelDecides(),
    promptCaching: caching,
  });

const everything = PromptCaching.on({
  retention: CacheRetention.FiveMinutes,
  cachedParts: [CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History],
});

describe("AC6: prompt caching — on({ retention?, cachedParts, key? }) | off()", () => {
  it("AC6: needs at least one cached part; the component's cache flag maps to an override", () => {
    expect(() => PromptCaching.on({ retention: CacheRetention.OneHour, cachedParts: [] })).toThrow(
      ConfigError.PromptCaching,
    );
    expect(promptCachingOfSetting(undefined)).toBeUndefined();
    expect(promptCachingOfSetting(true)).toBeUndefined();
    expect(promptCachingOfSetting(false)).toEqual(PromptCaching.off());
    expect(promptCachingOfSetting(everything)).toBe(everything);
    expect(promptCachingLabel(everything)).toBe("on (5m; system-prompt, tools, history)");
  });

  it("AC6: Anthropic through OpenRouter — cache_control after the system prompt and at the previous turn's end", () => {
    const wire = toWireRequest(conversation, planFor(everything));

    expect(wire.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "earlier replyWith", cache_control: { type: "ephemeral" } },
        ],
      },
      { role: "user", content: "second" },
    ]);
  });

  it("AC6: a one-hour retention sends its ttl; only the parts asked for are marked", () => {
    const hour = PromptCaching.on({
      retention: CacheRetention.OneHour,
      cachedParts: [CachedPart.History],
    });
    const wire = toWireRequest(
      {
        ...conversation,
        messages: [
          { role: "system", content: "rules" },
          { role: "assistant", content: [{ type: "text", text: "a" }] },
          { role: "user", content: "b" },
        ],
      },
      planFor(hour),
    );

    expect(wire.messages?.[0]).toEqual({ role: "system", content: "rules" });
    expect(wire.messages?.[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
  });

  it("AC6: models that cache automatically (Kimi) and caching off get no markers; OpenRouter asks for the cost", () => {
    const kimi = toWireRequest(
      { ...conversation, model: "moonshotai/kimi-k2.6" },
      planFor(everything, "moonshotai/kimi-k2.6"),
    );
    const off = toWireRequest(conversation, planFor(PromptCaching.off()));

    expect(kimi.messages).toEqual(conversation.messages);
    expect(off.messages).toEqual(conversation.messages);
    expect(off.usage).toEqual({ include: true });
  });

  it("AC6: OpenAI's dialect — prompt_cache_key and a one-day retention, no markers", async () => {
    const [body] = await wireBodies(
      [LocalModelProvider],
      [
        {
          model: "local/llama",
          modelProvider: "local-model-provider",
          temperature: 0,
          maxTokens: 10,
        },
      ],
    );

    expect(body).toMatchObject({ prompt_cache_key: "job-scout", prompt_cache_retention: "24h" });
  });

  it("AC6: the component's caching wins over the provider's", async () => {
    const [body] = await wireBodies(
      [LocalModelProvider],
      [
        {
          ...claude,
          model: "local/llama",
          modelProvider: "local-model-provider",
          promptCaching: PromptCaching.off(),
        },
      ],
    );

    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("PromptCaching.on() defaults", () => {
  it("with no option it caches system prompt, tools and history for five minutes; no part is refused", () => {
    expect(PromptCaching.on()).toEqual({
      kind: "on",
      retention: CacheRetention.FiveMinutes,
      cachedParts: [CachedPart.SystemPrompt, CachedPart.Tools, CachedPart.History],
    });
    expect(PromptCaching.on({ key: "job" })).toMatchObject({ kind: "on", key: "job" });
    expect(() => PromptCaching.on({ cachedParts: [] })).toThrow(ConfigError.PromptCaching);
  });
});
