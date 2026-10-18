import { TestWorkflow, TestApplication } from "./fixtures/test-workflow/test.workflow.js";
import { workflowOf } from "../src/testing/index.js";
import { KEYS } from "./models/gateway.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { createAppDeps } from "../src/app/app-deps.js";
import { createApp } from "../src/application/create-app.js";
import type { ModelGateway } from "../src/llm/gateway.js";
import { TestChat } from "./fixtures/test-flow/test.flow.js";
import { providerStub } from "./models/stub.js";
import { execute } from "./helpers/flow.js";
import { ExecutionStatus } from "../src/app/types.js";

describe("createAppDeps", () => {
  it("wires every agent of the flow with a prompt, and its Jev router", async () => {
    const deps = await createAppDeps(await workflowOf(TestWorkflow), {
      processEnv: { TERN_DB: ":memory:" },
      environment: KEYS,
      providerFetch: providerStub([], [{ id: "test/researcher" }, { id: "test/coder" }]).fetch,
    });

    expect([...deps.registry.agents.keys()].sort()).toEqual(Object.keys(deps.prompts).sort());
    expect(deps.routers.map((router) => [router.name, router.model])).toEqual([
      ["main-router", "typesafe/jev-1.13"],
    ]);
    expect(deps.tools("current_time").name).toBe("current_time");
    await deps.close();
  });
});

/** Decides by router: guards pass, "main-router" sends the message to the researcher. */
function scriptedDecisions(): ModelGateway["routeTo"] {
  return ({ router }) => {
    const next = router.startsWith("guard:") ? "pass" : "researcher-agent";
    return Promise.resolve({
      kind: "decided",
      decision: { next, reason: "scripted", confidence: 1 },
    });
  };
}

describe("AC12: createAppDeps on an injected model gateway", () => {
  it("AC12: needs no OpenRouter credentials, and every model call of a run goes through the gateway", async () => {
    const chatModel = vi.fn<ModelGateway["chatModel"]>(
      () => new FakeListChatModel({ responses: ["Found it."] }),
    );
    const routeTo = vi.fn(scriptedDecisions());
    const env = {
      TERN_DB: ":memory:",
      SPEND_LEDGER_DIR: mkdtempSync(join(tmpdir(), "agboss-135-")),
    };
    const app = await createApp(TestApplication, {
      processEnv: env,
      gateway: { chatModel, routeTo },
    });

    const result = await execute(app, TestChat, { text: "What time is it?" });
    await app.close();

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(routeTo.mock.calls.map(([spec]) => spec.router)).toEqual([
      "guard:prompt_injection",
      "main-router",
      "guard:pii",
    ]);
    expect(chatModel).toHaveBeenCalledWith(
      expect.objectContaining({ user: { kind: "agent", agent: "researcher-agent" } }),
    );
  });
});
