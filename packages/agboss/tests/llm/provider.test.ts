import { describe, expect, it } from "vitest";
import { type ChatDefaults, type ModelSettings } from "../../src/config/types.js";
import { TokenLimit } from "../../src/config/types.js";
import { resolveSettings } from "../../src/llm/registry.js";
import { wireBodies } from "../models/gateway.js";
import { TestOpenRouterProvider } from "../models/providers.fixture.js";

const defaults: ChatDefaults = { temperature: 0 };

const send = async (settings: ModelSettings): Promise<Record<string, unknown>> => {
  const [body] = await wireBodies([TestOpenRouterProvider], [resolveSettings(settings, defaults)]);
  return body ?? {};
};

describe("provider routing and the output ceiling (#97, now on the provider #151)", () => {
  it("AC1: provider routing reaches OpenRouter as the provider's typed request field", async () => {
    expect((await send({ model: "a/b" })).provider).toEqual({ ignore: ["Inceptron"] });
  });

  it("AC2: 8192 output tokens by default; no ceiling only when TokenLimit.MODEL_MAX is set explicitly", async () => {
    expect((await send({ model: "a/b" })).max_tokens).toBe(8192);
    expect((await send({ model: "a/b", maxTokens: 2000 })).max_tokens).toBe(2000);
    expect(
      (await send({ model: "a/b", maxTokens: TokenLimit.MODEL_MAX })).max_tokens,
    ).toBeUndefined();
  });
});
