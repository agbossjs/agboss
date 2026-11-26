import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { usd } from "../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { providerClients } from "../../src/llm/provider-clients.js";
import { ModelKind } from "../../src/models/index.js";
import { ModelProviderDirectory } from "../../src/models/resolve.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import type { ProviderResolution, RegisteredModelProvider } from "../../src/models/resolve.js";
import { request } from "../routers/fixtures.js";
import { ENV, instanceCalls } from "../models/gateway.js";
import { LocalModelProvider, TestDecisionsProvider } from "../models/providers.fixture.js";
import { providerStub } from "../models/stub.js";

const options = (send = providerStub().fetch) => ({
  env: ENV,
  calls: instanceCalls(),
  send,
});

describe("AC6: the default gateway resolves each model's provider", () => {
  it("AC6: Jev decisions go to the provider that decides, with its key", async () => {
    const stub = providerStub([
      { body: { answers: { route: { choice: "finish" } }, usage: { cost: 0.0001 } } },
    ]);
    const gateway = createProviderGateway(
      ModelProviderDirectory.of([TestDecisionsProvider]),
      options(stub.fetch),
    );

    const outcome = await gateway.routeTo({
      router: "main",
      model: {
        kind: "jev",
        model: "typesafe/jev-1.13",
        modelProvider: "decisions-model-provider",
      },
      request,
    });

    expect(outcome).toMatchObject({
      kind: "decided",
      decision: { next: "finish" },
      usage: { costUsd: usd(0.0001) },
    });
    expect(stub.requests[0]).toMatchObject({
      url: "https://openrouter.ai/api/alpha/decisions",
      authorization: "Bearer k",
    });
  });

  it("AC6: a model no provider is named for fails with model.missing-provider at the call", async () => {
    const gateway = createProviderGateway(
      ModelProviderDirectory.of([LocalModelProvider]),
      options(),
    );

    expect(() =>
      gateway.chatModel({
        user: { kind: "compaction", compaction: "conversation-compaction" },
        settings: { model: "x/y", temperature: 0, maxTokens: 1 },
      }),
    ).toThrow(ConfigError.ModelSettings);
    expect(
      await gateway.routeTo({
        router: "main",
        model: {
          kind: "jev",
          model: "typesafe/jev-1.13",
          modelProvider: "decisions-model-provider",
        },
        request,
      }),
    ).toMatchObject({ kind: "failed" });
  });

  it("AC6: a provider without chat or decisions for a resolved model is a wiring error", async () => {
    const bare: RegisteredModelProvider = {
      options: modelProviderOf(LocalModelProvider),
      type: LocalModelProvider,
      handler: { capabilities: () => Promise.resolve(undefined) },
    };
    class ResolvesAnything extends ModelProviderDirectory {
      override resolve(): ProviderResolution {
        return { kind: "resolved", provider: bare };
      }
    }
    const clients = providerClients(new ResolvesAnything([]), options());

    expect(() => clients.chatModel({ model: "local/llama", temperature: 0, maxTokens: 1 })).toThrow(
      ConfigError.ModelProvider,
    );
    await expect(
      clients.jevClient({ model: "local/llama", state: "", questions: {} }),
    ).rejects.toThrow(ConfigError.ModelProvider);
    expect(ModelKind.Chat).toBe("chat");
  });
});
