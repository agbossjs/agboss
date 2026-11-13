/**
 * #716 — every kind of model use is connected at start: a provider that only one of them resolves
 * to (an agent, compaction, judge, default or flow router, model arbiter, PII detection, reply
 * interpreter, guardrail, reranker, a decision model, a breaker's fallback) fails `createApp` on a
 * missing key, never the first call in the middle of a run. `MODEL_USE_KINDS` is the list walked.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createAppWith } from "../../src/application/create-app.js";
import type { Class } from "../../src/components/injection.js";
import { EmptyEnvironment } from "../../src/index.js";
import { EnvironmentError } from "../../src/environments/errors.js";
import { DecisionsModelProvider } from "../../src/models/index.js";
import { MODEL_USE_KINDS, type ModelUseKind } from "../../src/models/uses.js";
import { workflowModelUsesOf } from "../../src/models/resolution.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { LocalModelProvider } from "./providers.fixture.js";
import { providerStub } from "./stub.js";
import { everyKindWorkflows, type KindModels } from "./startup-keys/components.js";
import { FallbackLocalModelProvider, KeyedModelProvider } from "./startup-keys/providers.js";

const LOCAL = "local/llama";
const KEYED = "keyed/llama";
const DECISION = "typesafe/jev-1.13";
const ALL_LOCAL: KindModels = {
  agents: LOCAL,
  compactions: LOCAL,
  judges: LOCAL,
  defaults: LOCAL,
  routers: LOCAL,
  arbiters: LOCAL,
  pii: LOCAL,
  replyInterpreters: LOCAL,
  guardrails: LOCAL,
  rerankers: LOCAL,
};

/** An application of every kind of model use; no environment, so no key is there. */
function applicationFor(models: KindModels, providers: readonly Class[]): Class {
  const parts = everyKindWorkflows(models);
  @Application({
    name: "every-kind-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [...parts.workflows],
    providers: [...providers, ...parts.providers],
    budgets: TEST_BUDGETS,
  })
  class EveryKindApplication {}
  return EveryKindApplication;
}

const VAULT_ONLY = [FallbackLocalModelProvider];
const SERVERS = [LocalModelProvider, KeyedModelProvider, DecisionsModelProvider];
const start = (application: Class) =>
  createAppWith(application, {
    processEnv: {},
    providerFetch: providerStub([], [{ id: LOCAL }]).fetch,
  });
const using = (kind: ModelUseKind, model: string): KindModels => ({ ...ALL_LOCAL, [kind]: model });

describe("#716: a provider only one kind of model use needs fails createApp without its key", () => {
  it("control: every kind on the keyless local server starts with no key at all", async () => {
    const app = await start(applicationFor(ALL_LOCAL, SERVERS));
    await app.close();
    expect(app.models.length).toBeGreaterThan(0);
  });

  it.each(MODEL_USE_KINDS)("%s on a keyed provider", async (kind) => {
    const started = start(applicationFor(using(kind, KEYED), SERVERS));

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/no keyedApiKey/);
  });

  it.each([
    "defaults",
    "routers",
    "arbiters",
    "judges",
    "replyInterpreters",
    "guardrails",
  ] as const)("%s on a decision model (the Decisions provider)", async (kind) => {
    const started = start(applicationFor(using(kind, DECISION), SERVERS));

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/no openRouterApiKey/);
  });

  it("a breaker's fallback is connected at start: its missing key fails createApp", async () => {
    const started = start(
      applicationFor(ALL_LOCAL, [FallbackLocalModelProvider, KeyedModelProvider]),
    );

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/no keyedApiKey/);
  });

  it("an unlisted breaker's fallback is connected at start too: its missing key fails createApp", async () => {
    const started = start(applicationFor(ALL_LOCAL, VAULT_ONLY));

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/no keyedApiKey/);
  });
});

describe("#716: the kinds of model use are one list", () => {
  it("the workflows' uses cover every kind of MODEL_USE_KINDS, and no key has another", async () => {
    const assembled = await applicationOf(applicationFor(ALL_LOCAL, SERVERS));
    const kinds = new Set(
      assembled.workflows.flatMap((workflow) =>
        workflowModelUsesOf(workflow).map((use) => use.key.split(".")[0]),
      ),
    );

    expect([...kinds].sort()).toEqual([...MODEL_USE_KINDS].sort());
  });

  it.each(MODEL_USE_KINDS)("a component of kind %s yields at least one model use", async (kind) => {
    const assembled = await applicationOf(applicationFor(using(kind, LOCAL), SERVERS));
    const uses = assembled.workflows.flatMap((workflow) => workflowModelUsesOf(workflow));

    expect(uses.filter((use) => use.key.split(".")[0]?.split(" ").pop() === kind)).not.toHaveLength(
      0,
    );
  });
});
