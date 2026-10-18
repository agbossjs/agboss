import { describe, expect, it } from "vitest";
import { createProviderGateway } from "../../src/llm/gateway.js";
import { providerClients, ProviderCapabilityError } from "../../src/llm/provider-clients.js";
import {
  ConfigurationError,
  DecisionsModelProvider,
  ModelProviderDirectory,
  ModelPurpose,
} from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import type { ProviderResolution, RegisteredModelProvider } from "../../src/models/resolve.js";
import { request } from "../routers/fixtures.js";
import { ENV, instanceCalls, KEYS } from "../models/gateway.js";
import { LocalModelProvider } from "../models/providers.fixture.js";
import { providerStub } from "../models/stub.js";

const options = (send = providerStub().fetch) => ({
  env: ENV,
  environment: KEYS,
  calls: instanceCalls(),
  send,
});

describe("AC6: the default gateway resolves each model's provider", () => {
  it("AC6: Jev decisions go to the provider that decides, with its key", async () => {
    const stub = providerStub([
      { body: { answers: { route: { choice: "finish" } }, usage: { cost: 0.0001 } } },
    ]);
    const gateway = createProviderGateway(
      ModelProviderDirectory.of([DecisionsModelProvider]),
      options(stub.fetch),
    );

    const outcome = await gateway.routeTo({
      router: "main",
      model: { kind: "jev", model: "typesafe/jev-1.13" },
      request,
    });

    expect(outcome).toMatchObject({
      kind: "decided",
      decision: { next: "finish" },
      usage: { costUsd: 0.0001 },
    });
    expect(stub.requests[0]).toMatchObject({
      url: "https://openrouter.ai/api/alpha/decisions",
      authorization: "Bearer k",
    });
  });

  it("AC6: a model no provider serves fails with model.unserved at the call", async () => {
    const gateway = createProviderGateway(
      ModelProviderDirectory.of([LocalModelProvider]),
      options(),
    );

    expect(() =>
      gateway.chatModel({
        user: { kind: "compaction" },
        settings: { model: "x/y", temperature: 0, maxTokens: 1 },
      }),
    ).toThrow(ConfigurationError);
    expect(
      await gateway.routeTo({
        router: "main",
        model: { kind: "jev", model: "typesafe/jev-1.13" },
        request,
      }),
    ).toMatchObject({ kind: "failed" });
  });

  it("AC6: a provider without chat or decisions for a resolved model is a wiring error", () => {
    const bare: RegisteredModelProvider = {
      options: modelProviderOf(LocalModelProvider),
      handler: { capabilities: () => Promise.resolve(undefined) },
    };
    class ResolvesAnything extends ModelProviderDirectory {
      override resolve(): ProviderResolution {
        return { kind: "resolved", provider: bare };
      }
    }
    const clients = providerClients(new ResolvesAnything([]), options());

    expect(() => clients.chatModel({ model: "local/llama", temperature: 0, maxTokens: 1 })).toThrow(
      ProviderCapabilityError,
    );
    expect(() => clients.jevClient({ model: "local/llama", state: "", questions: {} })).toThrow(
      ProviderCapabilityError,
    );
    expect(ModelPurpose.Chat).toBe("chat");
  });
});
