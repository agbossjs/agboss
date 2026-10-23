/**
 * #385 — a transport provider at assembly: both modes at once do not compile and fail assembly
 * (`[model-provider.both-modes]`), its `deps` are checked with the components', `agboss describe`
 * names it, `configHash` covers it, and `capabilities` (optional) is checked at start when given.
 */
import { describe, expect, it } from "vitest";
import { Injectable, TenantContext } from "../../../src/index.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { InjectionToken } from "../../../src/components/injection.js";
import { applicationLines, describedApplicationOf } from "../../../src/describe/application.js";
import { describeWorkflow } from "../../../src/describe/describe-workflow.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import {
  ConfigurationError,
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelCapabilities,
  type ModelProviderHandler,
  type ModelProviderResponse,
} from "../../../src/models/index.js";
import { configSnapshot } from "../../../src/run/versions.js";
import { versionOf } from "../../../src/terns/index.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { BedrockApplication, bedrockApplicationOn } from "./bedrock-apps.fixture.js";
import {
  answer,
  BedrockModelProvider,
  BedrockSdkClient,
  ScriptedBedrockClient,
} from "./bedrock-provider.fixture.js";
import { transportApp } from "./transport-app.js";

const transport = {
  description: "A transport",
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 1, window: minutes(1), openFor: minutes(1) },
};

// @ts-expect-error -- a transport (complete) with a base URL: both modes at once
@ModelProvider({ ...transport, name: "both-model-provider", baseUrl: "http://both.test/v1" })
class BothModelProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer("never"));
  }
}

const MISSING = new InjectionToken<string>("BEDROCK_REGION");

@ModelProvider({ ...transport, name: "unwired-model-provider", deps: [MISSING] })
class UnwiredModelProvider implements ModelProviderHandler {
  constructor(private readonly region: string) {}
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer(this.region));
  }
}

/** A transport that lists its models: `bedrock/claude` only. */
@Injectable()
class ListingClient {}

@ModelProvider({
  ...transport,
  name: "listing-model-provider",
  deps: [ListingClient, TenantContext],
})
class ListingModelProvider implements ModelProviderHandler {
  constructor(
    private readonly listingClient: ListingClient,
    private readonly tenantContext: TenantContext,
  ) {}
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve(answer(this.tenantContext.tenantId));
  }
  capabilities(model: string): Promise<ModelCapabilities | undefined> {
    return Promise.resolve(model === "bedrock/claude" ? { model } : undefined);
  }
}

describe("#385: a transport provider at assembly, in describe and in configHash", () => {
  it("[model-provider.both-modes]: complete(request) with a baseUrl fails the application's assembly", async () => {
    const application = bedrockApplicationOn({
      name: "both-application",
      providers: [BothModelProvider],
    });

    const assembled = applicationOf(application, {});

    await expect(assembled).rejects.toBeInstanceOf(GraphRuleError);
    await expect(assembled).rejects.toThrow(
      /\[model-provider\.both-modes\] both-model-provider \(BothModelProvider\) implements complete\(request\) and sets baseUrl/,
    );
  });

  it("deps: a dependency without a provider fails at assembly, naming the provider class", async () => {
    const application = bedrockApplicationOn({
      name: "unwired-application",
      providers: [UnwiredModelProvider],
    });

    await expect(applicationOf(application, {})).rejects.toThrow(
      'UnwiredModelProvider: "BEDROCK_REGION" is not registered',
    );
  });

  it("describe: model → bedrock-model-provider, and the provider as a transport", async () => {
    const assembled = await applicationOf(BedrockApplication, {});
    const [workflow] = assembled.workflows;
    if (workflow === undefined) throw new Error("a workflow");

    expect(applicationLines(describedApplicationOf(assembled))).toContain(
      "  bedrock-model-provider → BedrockModelProvider (listed in @Application providers) · serves /^bedrock\\//" +
        " · transport: BedrockModelProvider.complete()",
    );
    expect(describeWorkflow(workflow)).toContain(
      "  agents.bedrock-desk-agent  model: bedrock/claude → bedrock-model-provider",
    );
  });

  it("configHash: a transport provider is in the hash; another class under its name is another hash", async () => {
    const hashOf = async (providers: readonly (typeof BedrockModelProvider)[]): Promise<string> => {
      const assembled = await applicationOf(
        bedrockApplicationOn({ name: "hashed-application", providers }),
        {},
      );
      const [workflow] = assembled.workflows;
      return workflow === undefined ? "" : versionOf(configSnapshot(workflow));
    };
    @ModelProvider({
      ...transport,
      name: "bedrock-model-provider",
      deps: [BedrockSdkClient, TenantContext],
    })
    class OtherBedrockModelProvider extends BedrockModelProvider {}

    const base = await hashOf([BedrockModelProvider]);

    expect(await hashOf([BedrockModelProvider])).toBe(base);
    expect(await hashOf([OtherBedrockModelProvider])).not.toBe(base);
  });

  it("capabilities, when given, are checked at start: a model it does not list fails before any call", async () => {
    const client = new ScriptedBedrockClient([]);
    const listed = bedrockApplicationOn({
      name: "listed-application",
      providers: [ListingModelProvider, ListingClient],
    });
    const unlisted = bedrockApplicationOn({
      name: "unlisted-application",
      model: "bedrock/titan",
      providers: [ListingModelProvider, ListingClient],
    });

    await expect(transportApp(listed, { client })).resolves.toBeDefined();
    await expect(transportApp(unlisted, { client })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(transportApp(unlisted, { client })).rejects.toMatchObject({
      problems: [expect.objectContaining({ code: "model.unknown-model", model: "bedrock/titan" })],
    });
  });
});
