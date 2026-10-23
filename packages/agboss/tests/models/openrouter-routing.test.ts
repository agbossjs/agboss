/**
 * #395 PR 6 (S8): OpenRouter's host routing — camelCase in TypeScript (`allowFallbacks`,
 * `quantizations: [Quantization.Bf16]`), snake_case only in the body sent; `UsageRecord.servedBy`
 * from the host OpenRouter names; `agboss check --models` checks the pinned hosts and
 * quantizations against each served model's endpoints (`[model.no-matching-endpoint]`). No network:
 * every answer is a stub.
 */
import { describe, expect, it } from "vitest";
import { recordUsage } from "../../src/finops/usage.js";
import { checkModelUses } from "../../src/models/check.js";
import {
  CachedPart,
  CacheRetention,
  DecisionsModelProvider,
  ModelCost,
  ModelProvider,
  ModelProviderDirectory,
  OpenRouterProvider,
  PromptCaching,
  ProviderSort,
  Quantization,
  Reasoning,
  RetryPolicy,
  type OpenRouterFields,
} from "../../src/models/index.js";
import { routingProblemsOf, type ModelEndpoint } from "../../src/models/openrouter-routing.js";
import { servedByFetch } from "../../src/models/served-by.js";
import type { ProviderFetch } from "../../src/models/resilient-fetch.js";
import { modelUsesOf } from "../../src/models/uses.js";
import { minutes, seconds } from "../../src/units/index.js";
import type { AgentsConfigOf } from "../../src/config/types.js";
import { completion, KIMI_ENTRY, providerStub } from "./stub.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { ENV, instanceCalls, KEYS } from "./gateway.js";

/** An OpenRouter provider pinned to Fireworks at bf16, without fallbacks. */
@ModelProvider({
  name: "pinned-openrouter-model-provider",
  description: "OpenRouter, one host at one precision",
  serves: [/^moonshotai\//],
  baseUrl: "http://openrouter.test/api/v1",
  apiKey: "openRouterApiKey",
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.whereSupported({
    retention: CacheRetention.FiveMinutes,
    cachedParts: [CachedPart.SystemPrompt],
  }),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 3, window: minutes(1), openFor: seconds(30) },
})
class PinnedOpenRouterProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {
    provider: {
      only: ["fireworks"],
      ignore: ["together"],
      quantizations: [Quantization.Bf16],
      allowFallbacks: false,
      sort: ProviderSort.Throughput,
    },
  };
}

const FIREWORKS_BF16: ModelEndpoint = {
  host: "Fireworks",
  slug: "fireworks",
  quantization: "bf16",
};
const TOGETHER_FP8: ModelEndpoint = { host: "Together", slug: "together", quantization: "fp8" };

describe("the routing on the wire: camelCase in, snake_case out", () => {
  it("allowFallbacks becomes allow_fallbacks; every other field as it is", () => {
    const plan = new PinnedOpenRouterProvider().wirePlanOf({
      settings: { model: "moonshotai/kimi-k2.6", temperature: 0, maxTokens: 10 },
      reasoning: Reasoning.modelDecides(),
      promptCaching: PromptCaching.off(),
    });

    expect(plan.fields.provider).toEqual({
      only: ["fireworks"],
      ignore: ["together"],
      quantizations: ["bf16"],
      allow_fallbacks: false,
      sort: "throughput",
    });
  });
});

describe("UsageRecord.servedBy: the host that served the call", () => {
  const answered =
    (body: unknown, type: string): ProviderFetch =>
    () =>
      Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          headers: { "content-type": type },
        }),
      );

  it("a JSON answer: its provider copied into its usage, read by recordUsage", async () => {
    const reply = { ...(completion("ok", 0.001).body as object), provider: "Fireworks" };
    const response = await servedByFetch(answered(reply, "application/json"))("http://x");
    const { usage } = (await response.json()) as { usage: Record<string, unknown> };

    const record = recordUsage(
      "agent:scout",
      { model: "moonshotai/kimi-k2.6" },
      {
        response_metadata: { usage },
      },
    );

    expect(record).toMatchObject({ servedBy: "Fireworks", costUsd: 0.001, costSource: "api" });
  });

  it("through the provider's chat model: the call's usage record names its host", async () => {
    const stub = providerStub([
      { body: { ...(completion("ok", 0.001).body as object), provider: "Fireworks" } },
    ]);
    const gateway = createProviderGateway(
      ModelProviderDirectory.of([PinnedOpenRouterProvider, DecisionsModelProvider]),
      { env: ENV, environment: KEYS, calls: instanceCalls(), send: stub.fetch },
    );
    const settings = { model: "moonshotai/kimi-k2.6", temperature: 0, maxTokens: 10 };

    const message = await gateway
      .chatModel({ user: { kind: "agent", agent: "scout" }, settings })
      .invoke("hi");

    expect(recordUsage("agent:scout", settings, message)).toMatchObject({
      servedBy: "Fireworks",
      costUsd: 0.001,
    });
    expect(stub.requests.at(-1)?.body).toMatchObject({
      provider: { only: ["fireworks"], allow_fallbacks: false, quantizations: ["bf16"] },
    });
  });

  it("a streamed answer: the chunk with usage carries the host", async () => {
    const chunks = [
      `data: ${JSON.stringify({ provider: "Fireworks", choices: [{ delta: { content: "o" } }] })}`,
      `data: ${JSON.stringify({ provider: "Fireworks", choices: [], usage: { cost: 0.002 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const response = await servedByFetch(answered(chunks, "text/event-stream"))("http://x");
    const text = await response.text();

    expect(text).toContain('"usage":{"cost":0.002,"agboss_served_by":"Fireworks"}');
    expect(text).toContain("data: [DONE]");
  });

  it("an answer that names no host, or an error, is left as it is", async () => {
    const plain = await servedByFetch(answered(completion("ok", 0.001).body, "application/json"))(
      "http://x",
    );
    const failed = await servedByFetch(() => Promise.resolve(new Response("{}", { status: 429 })))(
      "http://x",
    );
    const { usage } = (await plain.json()) as { usage: Record<string, unknown> };

    const record = recordUsage("agent:scout", { model: "m" }, { response_metadata: { usage } });

    expect(record.servedBy).toBeUndefined();
    expect(failed.status).toBe(429);
  });
});

describe("routingProblemsOf: pinned hosts and quantizations against the endpoints", () => {
  const routing = { only: ["fireworks"], quantizations: [Quantization.Bf16] };

  it("a pinned host that serves the model at a pinned precision: no problem", () => {
    expect(routingProblemsOf(routing, [FIREWORKS_BF16, TOGETHER_FP8])).toEqual([]);
  });

  it("a pinned host that does not serve it; no allowed host at the precision", () => {
    expect(routingProblemsOf(routing, [TOGETHER_FP8])).toEqual([
      { value: "provider.only: fireworks", supported: "endpoints: together (fp8)" },
      { value: "provider.quantizations: bf16", supported: "endpoints: together (fp8)" },
    ]);
  });

  it("an ignored host does not count for a quantization", () => {
    const ignoring = { ignore: ["fireworks"], quantizations: [Quantization.Bf16] };

    expect(routingProblemsOf(ignoring, [FIREWORKS_BF16, TOGETHER_FP8])).toEqual([
      {
        value: "provider.quantizations: bf16",
        supported: "endpoints: fireworks (bf16), together (fp8)",
      },
    ]);
  });
});

describe("agboss check --models: [model.no-matching-endpoint]", () => {
  const config: AgentsConfigOf<string> = {
    name: "pinned",
    version: "1",
    defaults: {
      models: { temperature: 0, maxTokens: 1000 },
      router: { kind: "jev", model: "typesafe/jev-1.13" },
      tools: { maxToolCalls: 1 },
      uncompactedTurns: 1,
    },
    agents: { scout: { model: "moonshotai/kimi-k2.6", description: "s" } },
  };
  const uses = modelUsesOf(config, []);

  /** OpenRouter's model list and the model's endpoints, the URLs asked kept. */
  const openRouter = (endpoints: readonly Record<string, unknown>[]) => {
    const asked: string[] = [];
    const send: ProviderFetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      asked.push(url);
      if (url.endsWith("/models")) return Promise.resolve(Response.json({ data: [KIMI_ENTRY] }));
      return Promise.resolve(Response.json({ data: { id: "moonshotai/kimi-k2.6", endpoints } }));
    };
    return { send, asked };
  };

  it("a pinned host the model is not served by is reported, naming the endpoints", async () => {
    const { send, asked } = openRouter([
      { provider_name: "Together", tag: "together/fp8", quantization: "fp8" },
    ]);

    const problems = await checkModelUses(
      uses,
      ModelProviderDirectory.of([PinnedOpenRouterProvider, DecisionsModelProvider]),
      { env: {}, send, endpoints: true },
    );

    expect(problems).toEqual([
      {
        code: "model.no-matching-endpoint",
        key: "agents.scout",
        value: "provider.only: fireworks",
        model: "moonshotai/kimi-k2.6",
        supported: "pinned-openrouter-model-provider: endpoints: together (fp8)",
      },
      expect.objectContaining({ value: "provider.quantizations: bf16" }),
    ]);
    expect(asked).toContain("http://openrouter.test/api/v1/models/moonshotai/kimi-k2.6/endpoints");
  });

  it("served as pinned: nothing; at startup (no endpoints option) the endpoints are not asked", async () => {
    const served = openRouter([
      { provider_name: "Fireworks", tag: "fireworks/bf16", quantization: "bf16" },
    ]);
    const atStartup = openRouter([]);
    const directory = () =>
      ModelProviderDirectory.of([PinnedOpenRouterProvider, DecisionsModelProvider]);

    expect(
      await checkModelUses(uses, directory(), { env: {}, send: served.send, endpoints: true }),
    ).toEqual([]);
    expect(await checkModelUses(uses, directory(), { env: {}, send: atStartup.send })).toEqual([]);
    expect(atStartup.asked.some((url) => url.endsWith("/endpoints"))).toBe(false);
  });
});
