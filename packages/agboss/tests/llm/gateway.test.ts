import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedModelSettings } from "../../src/config/types.js";
import {
  createModelGateway,
  createProviderGateway,
  type ModelGateway,
} from "../../src/llm/gateway.js";
import type { JevClient } from "../../src/llm/jev-client.js";
import { EnvironmentError } from "../../src/environments/errors.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { KEYS } from "../models/gateway.js";
import { DEFAULT_MODEL_PROVIDERS, directoryOf } from "../../src/models/workflow-models.js";
import { createModelRegistry } from "../../src/llm/registry.js";
import { CompactionStrategy } from "../../src/compaction/compaction.decorator.js";
import { createRouter, type RouteOutcome } from "../../src/routers/index.js";
import { routeTo, fakeChatFactory, testConfig, testRouter, unusedJevClient } from "../helpers.js";
import { jevAnswer, request } from "../routers/fixtures.js";

const settings: ResolvedModelSettings = {
  model: "test/router",
  temperature: 0,
  maxTokens: 10,
  price: { inputPerMTok: 1, outputPerMTok: 2 },
};

/** A gateway that answers every decision with `next` and hands out one fake chat model. */
function recordingGateway(next = "alpha") {
  const model = new FakeListChatModel({ responses: ["fake"] });
  const chatModel = vi.fn<ModelGateway["chatModel"]>(() => model);
  const outcome: RouteOutcome = { kind: "decided", decision: { next, reason: "stub" } };
  const decideFn = vi.fn<ModelGateway["routeTo"]>(() => Promise.resolve(outcome));
  return { gateway: { chatModel, routeTo: decideFn }, chatModel, routeTo: decideFn, model };
}

describe("AC12: the default model gateway", () => {
  it("AC12: creates a chat model per settings and shares it between identical settings", () => {
    const factory = vi.fn(fakeChatFactory({}));
    const gateway = createModelGateway({ chatModel: factory, jevClient: unusedJevClient });

    const first = gateway.chatModel({ user: { kind: "agent", agent: "alpha" }, settings });
    const second = gateway.chatModel({
      user: { kind: "compaction", compaction: "conversation-compaction" },
      settings,
    });

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("AC12: decides on Jev through the Jev client, with the routes as criteria", async () => {
    const jev = vi.fn<JevClient>(() => Promise.resolve(jevAnswer({ choice: "finish" })));
    const gateway = createModelGateway({ chatModel: fakeChatFactory({}), jevClient: jev });

    const outcome = await gateway.routeTo({
      router: "main",
      model: { kind: "jev", model: "typesafe/jev-test" },
      request,
    });

    expect(outcome).toMatchObject({ kind: "decided", decision: { next: "finish" } });
    expect(jev.mock.calls[0]?.[0]).toMatchObject({
      model: "typesafe/jev-test",
      questions: { route: { criteria: { alpha: "facts", finish: "done" } } },
    });
  });

  it("AC12: decides on a chat model it creates for the router, priced from its settings", async () => {
    const factory = vi.fn(fakeChatFactory({ "test/router": [routeTo("alpha")] }));
    const gateway = createModelGateway({ chatModel: factory, jevClient: unusedJevClient });

    const outcome = await gateway.routeTo({
      router: "main",
      model: { kind: "llm", settings },
      request,
    });

    expect(outcome).toMatchObject({
      kind: "decided",
      decision: { next: "alpha" },
      usage: { caller: "router:main", model: "test/router", costSource: "price-table" },
    });
    expect(factory).toHaveBeenCalledWith(settings);
  });

  it("AC12: the provider gateway needs every provider's API key before any call", () => {
    expect(() =>
      createProviderGateway(directoryOf(DEFAULT_MODEL_PROVIDERS), {
        env: { OPENROUTER_API_KEY: "a process variable is not a key" },
        environment: NO_ENVIRONMENT_VALUES,
      }),
    ).toThrow(EnvironmentError);
    expect(
      Object.keys(
        createProviderGateway(directoryOf(DEFAULT_MODEL_PROVIDERS), { env: {}, environment: KEYS }),
      ),
    ).toEqual(["chatModel", "routeTo", "decide"]);
  });
});

describe("AC12: model clients are asked for through the gateway", () => {
  it("AC12: the registry asks the gateway for every agent and the compaction model", () => {
    const { gateway, chatModel, model } = recordingGateway();
    const config = {
      ...testConfig,
      compactions: {
        "conversation-compaction": {
          strategy: CompactionStrategy.SummaryQueue,
          model: { model: "test/compact", price: { inputPerMTok: 1, outputPerMTok: 1 } },
          turnsBetweenCompactions: 4,
          summaryQueueLength: 2,
        },
        // a compaction without summaries has no model to ask for
        "no-summaries-compaction": { strategy: CompactionStrategy.None },
      },
    };

    const registry = createModelRegistry(config, gateway);

    expect(registry.agents.get("alpha")?.model).toBe(model);
    expect(chatModel.mock.calls.map(([spec]) => [spec.user, spec.settings.model])).toEqual([
      [{ kind: "agent", agent: "alpha" }, "test/alpha"],
      [{ kind: "agent", agent: "beta" }, "test/beta"],
      [{ kind: "compaction", compaction: "conversation-compaction" }, "test/compact"],
    ]);
  });

  it("AC12: a router decides through gateway.routeTo with its name, model and request", async () => {
    const { gateway, routeTo: decideFn } = recordingGateway("finish");
    const router = createRouter("main", testRouter, testConfig.defaults.models, gateway);

    const outcome = await router.route(request);

    expect(outcome).toEqual({ kind: "decided", decision: { next: "finish", reason: "stub" } });
    expect(decideFn).toHaveBeenCalledWith({
      router: "main",
      model: { kind: "jev", model: "typesafe/jev-test" },
      request,
    });
  });

  it("AC12: a router on a chat model passes its settings over the chat defaults", async () => {
    const { gateway, routeTo: decideFn } = recordingGateway();
    const model = { kind: "llm", model: "test/router", price: settings.price } as const;

    await createRouter("main", model, testConfig.defaults.models, gateway).route(request);

    expect(decideFn.mock.calls[0]?.[0].model).toMatchObject({
      kind: "llm",
      settings: { model: "test/router", maxTokens: "max" },
    });
  });
});

const SRC = join(import.meta.dirname, "../../src");
const MODEL_CLIENT_IMPORT = /from\s+["'](@langchain\/openai|[./]+llm\/(model|jev-client)\.js)["']/;
const SEAM_DIRS = ["llm/", "routers/", "models/"];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

describe("AC12: nothing outside src/llm, src/routers and src/models creates model clients", () => {
  it("AC12: no source file outside the seam imports a model client", () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !SEAM_DIRS.some((dir) => path.startsWith(dir)))
      .filter((path) => MODEL_CLIENT_IMPORT.test(readFileSync(join(SRC, path), "utf8")));

    expect(offenders).toEqual([]);
  });
});
