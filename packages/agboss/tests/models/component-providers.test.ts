/**
 * #1313b: every model-backed component takes `modelProvider` — router, arbiter, guardrail, PII policy
 * (reply interpreter, reranker and memory by the same cascade). A component that names no model takes
 * the default model of its levels (`profile → Component.model → Workflow.defaults.models.model →
 * Application.defaults.models.model → provider.model → provider.models.default`); a level's default
 * applies only when the component resolves to that level's provider; every provider reached this way
 * is subject to the provider rules.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { GraphRuleError } from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { modelUsesOf } from "../../src/models/uses.js";
import { ModelKind } from "../../src/models/model-kind.js";
import { routerModelOf, type FlowRouterFactoryDeps } from "../../src/graph/router-model.js";
import {
  AlphaModels,
  BadPricedModels,
  BetaModels,
  arbiterApplication,
  componentsApplication,
} from "./fixtures/component-providers.workflow.js";

async function workflowOf(application: Class) {
  const { workflows } = await applicationOf(application);
  const [workflow] = workflows;
  if (workflow === undefined) throw new Error("no workflow");
  return workflow;
}

/** What each component of the workflow resolved to: its model and provider's name. */
async function resolvedOf(application: Class) {
  const workflow = await workflowOf(application);
  const [guardrail] = workflow.guardrails?.guardrails ?? [];
  return {
    agent: workflow.config.agents["lv-agent"],
    router: workflow.routers[0],
    guardrail: guardrail === undefined || !("model" in guardrail) ? undefined : guardrail,
    detector: workflow.pii?.detectors[0],
  };
}

describe("#1313b: components take their provider's models through the cascade", () => {
  it("a component that names no model takes the application's default model, mapped by its provider", async () => {
    const { agent, router, guardrail, detector } = await resolvedOf(
      componentsApplication({ appProvider: AlphaModels, appModel: "fast" }),
    );

    expect(agent).toMatchObject({ model: "alpha/small", modelProvider: "alpha-models" });
    expect(router).toMatchObject({ model: "alpha/small", modelProvider: "alpha-models" });
    expect(guardrail).toMatchObject({ model: "alpha/small", modelProvider: "alpha-models" });
    // the PII detection names its model: as written, served by the provider of the cascade
    expect(detector).toMatchObject({ model: "detector/names", modelProvider: "alpha-models" });
  });

  it("no default model on any level: the provider's models.default", async () => {
    const { agent, router } = await resolvedOf(componentsApplication({ appProvider: AlphaModels }));

    expect(agent).toMatchObject({ model: "alpha/mid" });
    expect(router).toMatchObject({ model: "alpha/mid" });
  });

  it("the workflow's default model beats the application's when the provider is the same", async () => {
    const { agent, router } = await resolvedOf(
      componentsApplication({ appProvider: AlphaModels, appModel: "fast", workflowModel: "big" }),
    );

    expect(agent).toMatchObject({ model: "alpha/large" });
    expect(router).toMatchObject({ model: "alpha/large" });
  });

  it("a workflow with a provider of its own skips the application's default model, and keeps its own", async () => {
    const skipped = await resolvedOf(
      componentsApplication({
        appProvider: AlphaModels,
        appModel: "fast",
        workflowProvider: BetaModels,
      }),
    );
    expect(skipped.agent).toMatchObject({ model: "beta/only", modelProvider: "beta-models" });
    expect(skipped.router).toMatchObject({ model: "beta/only", modelProvider: "beta-models" });

    const kept = await resolvedOf(
      componentsApplication({
        appProvider: AlphaModels,
        appModel: "fast",
        workflowProvider: BetaModels,
        workflowModel: "ignored-by-beta-single-model",
      }),
    );
    // the workflow's default is the workflow's provider's: a vendor name is served as written
    expect(kept.agent).toMatchObject({ model: "ignored-by-beta-single-model" });
  });

  it("a component with a provider of its own skips both default models", async () => {
    const { agent, router, guardrail } = await resolvedOf(
      componentsApplication({
        appProvider: AlphaModels,
        appModel: "fast",
        workflowModel: "big",
        componentProvider: BetaModels,
      }),
    );

    expect(agent).toMatchObject({
      model: "beta/only",
      modelProvider: "beta-models",
      unpriced: true,
    });
    expect(router).toMatchObject({
      model: "beta/only",
      modelProvider: "beta-models",
      unpriced: true,
    });
    expect(guardrail).toMatchObject({
      model: "beta/only",
      modelProvider: "beta-models",
      unpriced: true,
    });
  });

  it('an agent that names the role "default" is not one that names nothing', async () => {
    const { agent } = await resolvedOf(
      componentsApplication({
        appProvider: AlphaModels,
        appModel: "fast",
        agentNamesDefault: true,
      }),
    );

    expect(agent).toMatchObject({ model: "alpha/mid" });
  });

  it("an arbiter that names no model takes the default of its cascade, or of its own provider", async () => {
    const inherited = await workflowOf(arbiterApplication());
    expect(inherited.arbiters).toEqual([
      {
        name: "arb-arbiter",
        model: "alpha/mid",
        modelProvider: "alpha-models",
        prompt: "Count it.",
      },
    ]);

    const own = await workflowOf(arbiterApplication(BetaModels));
    expect(own.arbiters).toEqual([
      {
        name: "arb-arbiter",
        model: "beta/only",
        modelProvider: "beta-models",
        prompt: "Count it.",
        unpriced: true,
      },
    ]);
  });

  it("the uses `check --models` lists carry the provider each component resolved to", async () => {
    const workflow = await workflowOf(
      componentsApplication({ appProvider: AlphaModels, componentProvider: BetaModels }),
    );
    const uses = modelUsesOf(
      workflow.config,
      workflow.routers.map((router) => router),
      {
        guardrails: (workflow.guardrails?.guardrails ?? []).flatMap((guardrail) =>
          "model" in guardrail ? [guardrail] : [],
        ),
        piiDetectors: workflow.pii?.detectors,
      },
    );

    expect(
      uses.filter(
        (use) =>
          use.key.startsWith("routers.") ||
          use.key.startsWith("guardrails.") ||
          use.key.startsWith("pii."),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "routers.lv-router", modelProvider: "beta-models" }),
        expect.objectContaining({
          key: "guardrails.lv-input-guardrail",
          modelProvider: "beta-models",
        }),
        expect.objectContaining({ key: "pii.lv-pii-policy", modelProvider: "beta-models" }),
      ]),
    );
  });
});

describe("#1313b: every provider a component names is subject to the provider rules", () => {
  it("a router, a guardrail and a PII policy on a provider with a wrong price fail the assembly", async () => {
    const error: unknown = await applicationOf(
      componentsApplication({ appProvider: AlphaModels, componentProvider: BadPricedModels }),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect((error as GraphRuleError).violations.map((found) => found.code)).toContain(
      "model.price-invalid",
    );
  });
});

describe("#1313b: the provider a component resolved to says what its model is", () => {
  const partialGateway: unknown = {
    kindOf: (provider?: string) =>
      provider === "decide-models"
        ? ModelKind.Decisions
        : provider === undefined
          ? undefined
          : ModelKind.Chat,
  };
  const gateway = partialGateway as FlowRouterFactoryDeps["gateway"];
  const deps: FlowRouterFactoryDeps = {
    gateway,
    chatDefaults: { temperature: 0 },
    chatModelSettings: (model) => ({ model }),
  };

  it("a decisions driver makes a decision model, a chat driver a chat model with its unpriced mark", () => {
    expect(routerModelOf("decide/one", deps, "decide-models")).toEqual({
      kind: "jev",
      model: "decide/one",
      modelProvider: "decide-models",
    });
    expect(routerModelOf("alpha/mid", deps, "alpha-models", true)).toMatchObject({
      kind: "llm",
      model: "alpha/mid",
      modelProvider: "alpha-models",
      unpriced: true,
    });
  });
});
