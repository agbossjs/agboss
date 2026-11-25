/**
 * #716 — every kind of model use is connected at start: a provider that only one of them resolves
 * to (an agent, compaction, judge, default or flow router, model arbiter, PII detection, reply
 * interpreter, guardrail, reranker, a decision model, a breaker's fallback) fails `createApp` on a
 * missing key, never the first call in the middle of a run. `MODEL_USE_KINDS` is the list walked.
 * No model's name picks a provider (#1313): each kind names its own, and the kinds that name none
 * (`defaults.router`, the built-in file models, a guardrail's default) take the workflow's or the
 * agent's.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import type { Class } from "../../src/components/injection.js";
import { EmptyEnvironment } from "../../src/index.js";
import { EnvironmentError } from "../../src/environments/errors.js";
import { MODEL_USE_KINDS, type ModelUseKind } from "../../src/models/uses.js";
import { workflowModelUsesOf } from "../../src/models/resolution.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { LocalModelProvider, TestDecisionsProvider } from "./providers.fixture.js";
import { providerStub } from "./stub.js";
import {
  everyKindWorkflows,
  type KindModels,
  type KindProviders,
} from "./startup-keys/components.js";
import { FallbackLocalModelProvider, KeyedModelProvider } from "./startup-keys/providers.js";

const LOCAL = "local/llama";
const KEYED = "keyed/llama";
const DECISION = "typesafe/jev-1.13";
const everyKind = <T>(value: T): Readonly<Record<ModelUseKind, T>> =>
  Object.fromEntries(MODEL_USE_KINDS.map((kind) => [kind, value])) as Record<ModelUseKind, T>;
const ALL_LOCAL: KindModels = everyKind(LOCAL);
const ALL_ON_LOCAL: KindProviders = everyKind(LocalModelProvider);

/** An application of every kind of model use; no process variable, so no key is there. */
function applicationFor(
  models: KindModels,
  providers: KindProviders,
  listed: readonly Class[],
): Class {
  const parts = everyKindWorkflows(models, providers);
  @Application({
    name: "every-kind-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [...parts.workflows],
    providers: [...listed, ...parts.providers],
    budgets: TEST_BUDGETS,
  })
  class EveryKindApplication {}
  return EveryKindApplication;
}

const SERVERS = [LocalModelProvider, KeyedModelProvider, TestDecisionsProvider];
const start = (application: Class) =>
  createTestAppWith(application, {
    processEnv: {},
    providerFetch: providerStub([], [{ id: LOCAL }]).fetch,
  });
/** Every kind on the keyless local server but `kind`, which is on `provider` with `model`. */
const using = (
  kind: ModelUseKind,
  model: string,
  provider: Class,
): { readonly models: KindModels; readonly providers: KindProviders } => ({
  models: { ...ALL_LOCAL, [kind]: model },
  providers: { ...ALL_ON_LOCAL, [kind]: provider },
});

/** The kind and the name of a use's key (`agents.x`, or behind a workflow's name `w agents.x`). */
const kindOfKey = (key: string): string => key.split(" ").pop()?.split(".")[0] ?? key;

/**
 * The provider of every use of `kind` (the `agents` kind is the desk agent: the others carry the
 * file kinds' provider or the arbiter's local one), and the other uses.
 */
async function providersByKind(application: Class, kind: ModelUseKind) {
  const assembled = await applicationOf(application);
  const uses = assembled.workflows.flatMap((workflow) => workflowModelUsesOf(workflow));
  const isOfKind = (use: (typeof uses)[number]): boolean =>
    kindOfKey(use.key) === kind && (kind !== "agents" || use.key.endsWith("desk-agent"));
  const ofKind = uses.filter(isOfKind);
  const others = uses.filter((use) => !isOfKind(use));
  return {
    ofKind: new Set(ofKind.map((use) => use.modelProvider)),
    count: ofKind.length,
    others,
  };
}

describe("#716: a provider only one kind of model use needs fails createApp without its key", () => {
  it("control: every kind on the keyless local server starts with no key at all", async () => {
    const app = await start(applicationFor(ALL_LOCAL, ALL_ON_LOCAL, SERVERS));
    await app.close();
    expect(app.models.length).toBeGreaterThan(0);
  });

  it.each(MODEL_USE_KINDS)("%s on a keyed provider", async (kind) => {
    const { models, providers } = using(kind, KEYED, KeyedModelProvider);
    const application = applicationFor(models, providers, SERVERS);

    // the kind's own uses resolve to the keyed provider: the key it fails on is theirs
    const { ofKind, count, others } = await providersByKind(application, kind);
    expect(count).toBeGreaterThan(0);
    expect([...ofKind]).toEqual(["keyed-model-provider"]);
    // a file model follows the agent that reads its files: that agent is on the keyed one too
    const followers = others.filter((use) => use.modelProvider === "keyed-model-provider");
    expect(followers.map((use) => kindOfKey(use.key))).toEqual(
      kind === "fileMaskers" || kind === "fileTranscribers" ? ["agents"] : [],
    );

    const started = start(application);

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/KEYED_API_KEY is not set/);
  });

  it.each([
    "defaults",
    "routers",
    "arbiters",
    "judges",
    "channelInterpreters",
    "guardrails",
  ] as const)("%s on a decision model (the Decisions provider)", async (kind) => {
    const { models, providers } = using(kind, DECISION, TestDecisionsProvider);
    const application = applicationFor(models, providers, SERVERS);

    const { ofKind, count } = await providersByKind(application, kind);
    expect(count).toBeGreaterThan(0);
    expect([...ofKind]).toEqual(["decisions-model-provider"]);
    const started = start(application);

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/OPENROUTER_API_KEY is not set/);
  });

  it("a breaker's fallback is connected at start: its missing key fails createApp", async () => {
    const started = start(
      applicationFor(ALL_LOCAL, { ...ALL_ON_LOCAL, agents: FallbackLocalModelProvider }, [
        FallbackLocalModelProvider,
        KeyedModelProvider,
      ]),
    );

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/KEYED_API_KEY is not set/);
  });

  it("an unlisted breaker's fallback is connected at start too: its missing key fails createApp", async () => {
    const started = start(
      applicationFor(ALL_LOCAL, { ...ALL_ON_LOCAL, agents: FallbackLocalModelProvider }, [
        FallbackLocalModelProvider,
      ]),
    );

    await expect(started).rejects.toBeInstanceOf(EnvironmentError);
    await expect(started).rejects.toThrow(/KEYED_API_KEY is not set/);
  });
});

describe("#716: the kinds of model use are one list", () => {
  it("the workflows' uses cover every kind of MODEL_USE_KINDS, and no key has another", async () => {
    const assembled = await applicationOf(applicationFor(ALL_LOCAL, ALL_ON_LOCAL, SERVERS));
    const kinds = new Set(
      assembled.workflows.flatMap((workflow) =>
        workflowModelUsesOf(workflow).map((use) => use.key.split(".")[0]),
      ),
    );

    expect([...kinds].sort()).toEqual([...MODEL_USE_KINDS].sort());
  });

  it.each(MODEL_USE_KINDS)("a component of kind %s yields at least one model use", async (kind) => {
    const { models, providers } = using(kind, LOCAL, LocalModelProvider);
    const assembled = await applicationOf(applicationFor(models, providers, SERVERS));
    const uses = assembled.workflows.flatMap((workflow) => workflowModelUsesOf(workflow));

    expect(uses.filter((use) => use.key.split(".")[0]?.split(" ").pop() === kind)).not.toHaveLength(
      0,
    );
  });
});
