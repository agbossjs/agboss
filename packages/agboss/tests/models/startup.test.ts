import { describe, expect, it } from "vitest";
import type { AgentsConfigOf } from "../../src/config/types.js";
import { createAppDeps } from "../../src/app/app-deps.js";
import { workflowOf } from "../../src/testing/index.js";
import { ConfigurationError, ModelProviderDirectory } from "../../src/models/index.js";
import { modelUsesOf } from "../../src/models/uses.js";
import { modelSummaryOf } from "../../src/models/workflow-models.js";
import { Priced } from "./fixtures/priced.workflow.js";
import { LocalModelProvider } from "./providers.fixture.js";
import { KIMI_ENTRY, providerStub } from "./stub.js";
import { KEYS } from "./gateway.js";

const config = (agents: AgentsConfigOf<string>["agents"]): AgentsConfigOf<string> => ({
  name: "check",
  version: "1",
  defaults: {
    models: { temperature: 0, maxTokens: 1000 },
    router: { kind: "jev", model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 1 },
    history: { limit: 1 },
  },
  agents,
});

describe("AC6: the check runs at every startup, before any model call", () => {
  it("AC6: a workflow whose settings do not fit fails with a ConfigurationError listing every problem", async () => {
    const stub = providerStub([], [KIMI_ENTRY]);
    const start = createAppDeps(await workflowOf(Priced), {
      processEnv: { TERN_DB: ":memory:" },
      environment: KEYS,
      providerFetch: stub.fetch,
    });

    await expect(start).rejects.toThrow(ConfigurationError);
    await expect(start).rejects.toMatchObject({
      problems: [{ code: "model.unknown-model", key: "agents.summariser-agent" }],
    });
    expect(stub.requests.every((request) => request.url.endsWith("/models"))).toBe(true);
  });

  it("AC6: the startup log shows each model's provider, reasoning and caching, and where they come from", async () => {
    const deps = await createAppDeps(await workflowOf(Priced), {
      processEnv: { TERN_DB: ":memory:" },
      environment: KEYS,
      providerFetch: providerStub([], [KIMI_ENTRY, { id: "local/llama" }]).fetch,
    });
    await deps.close();

    expect(deps.models).toEqual([
      "agents.summariser-agent  local/llama · provider local-model-provider · reasoning off (inherited from local-model-provider) · caching where supported (24h; system-prompt) (inherited from local-model-provider) · cost from the price table",
      "agents.writer-agent  moonshotai/kimi-k2.6 · provider openrouter-model-provider · reasoning off · caching where supported (5m; system-prompt, tools, history) (inherited from openrouter-model-provider) · cost from the response",
      "defaults.router  typesafe/jev-1.13 · provider decisions-model-provider · cost from the response",
    ]);
    expect(
      modelSummaryOf(
        modelUsesOf(config({ a: { model: "x/y", description: "a" } }), []),
        ModelProviderDirectory.of([LocalModelProvider]),
      ),
    ).toEqual([]);
  });
});
