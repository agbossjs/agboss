import { describe, expect, it } from "vitest";
import { file } from "../../src/components/file.js";

import { tool } from "@langchain/core/tools";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ResolvedModelSettings } from "../../src/config/types.js";
import { connectionOf } from "../../src/models/connections.js";
import { ENV, KEYS } from "./gateway.js";
import {
  DecisionsModelProvider,
  PromptCaching,
  Reasoning,
  toWireRequest,
} from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type WorkflowDefinition,
} from "../../src/index.js";
import { workflowOf } from "../../src/testing/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { parseWireRequest, wireFetch } from "../../src/models/wire.js";
import { TestOpenRouterProvider } from "./providers.fixture.js";
import { completion, providerStub } from "./stub.js";
import { start } from "../helpers/flow.js";

@WorkflowStart({ name: "task-workflow-start", description: "A task", input: WorkflowStartTextDto })
class Start {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
class Finish {}

const settings: ResolvedModelSettings = {
  model: "moonshotai/kimi-k2.6",
  temperature: 0,
  maxTokens: 100,
};
const env = ENV;

/** What OpenRouter receives for one call of the provider's chat model. */
async function bodyOf(bind?: (model: BaseChatModel) => Runnable<BaseLanguageModelInput, unknown>) {
  const stub = providerStub([completion()]);
  const provider = new TestOpenRouterProvider();
  const connection = connectionOf(modelProviderOf(TestOpenRouterProvider), {
    env,
    environment: KEYS,
    requireKeys: true,
    send: stub.fetch,
  });
  const model = provider.chat({
    settings,
    reasoning: Reasoning.modelDecides(),
    promptCaching: PromptCaching.off(),
    connection,
  });
  await (bind === undefined ? model : bind(model)).invoke([
    new SystemMessage("rules"),
    new HumanMessage("hi"),
  ]);
  return stub.requests[0]?.body ?? {};
}

const lookup = (name: string) =>
  tool(() => "x", {
    name,
    description: `${name} tool`,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
    },
  });

describe("AC6: the wire form, made in one place (toWireRequest)", () => {
  it("AC6: the wire body carries the provider's typed request fields", async () => {
    const body = await bodyOf();

    expect(body).toMatchObject({
      model: "moonshotai/kimi-k2.6",
      provider: { ignore: ["Inceptron"] },
    });
  });

  it("AC6: tools go out sorted by name, their schemas without $schema", async () => {
    const body = await bodyOf(
      (model) => model.bindTools?.([lookup("zeta"), lookup("alpha"), lookup("mid")]) ?? model,
    );
    const tools = body.tools as {
      function: { name: string; parameters: Record<string, unknown> };
    }[];

    expect(tools.map((t) => t.function.name)).toEqual(["alpha", "mid", "zeta"]);
    expect(tools.every((t) => !("$schema" in t.function.parameters))).toBe(true);
  });

  it("AC6: declaration order of tools changes nothing on the wire", () => {
    const fn = (name: string) => ({ type: "function", function: { name } });
    const plan = { fields: {}, cacheMarkers: [], cacheControl: { type: "ephemeral" as const } };

    expect(toWireRequest({ model: "m", tools: [fn("b"), fn("a")] }, plan)).toEqual(
      toWireRequest({ model: "m", tools: [fn("a"), fn("b")] }, plan),
    );
  });

  it("AC6: Jev routes are sent sorted by name", async () => {
    const stub = providerStub([{ body: { answers: { route: { choice: "b" } } } }]);
    const connection = connectionOf(modelProviderOf(DecisionsModelProvider), {
      env,
      environment: KEYS,
      requireKeys: true,
      send: stub.fetch,
    });

    await new DecisionsModelProvider().routeTo({
      decision: {
        model: "typesafe/jev-1.13",
        state: "x",
        questions: {
          route: { type: "choice", instructions: "pick", criteria: { zeta: "z", alpha: "a" } },
        },
      },
      connection,
    });

    const body = stub.requests[0]?.body as { questions: { route: { criteria: object } } };
    expect(Object.keys(body.questions.route.criteria)).toEqual(["alpha", "zeta"]);
  });

  it("AC6: a body the adapter cannot read passes through untouched", async () => {
    const stub = providerStub();
    const plan = {
      fields: { x: 1 },
      cacheMarkers: [],
      cacheControl: { type: "ephemeral" as const },
    };

    await wireFetch(plan, stub.fetch)("http://x.test/v1/chat/completions", {
      method: "POST",
      body: "not json",
    });
    await wireFetch(plan, stub.fetch)("http://x.test/v1/models");

    expect(parseWireRequest("[1]")).toBeUndefined();
    expect(stub.requests.map((r) => r.raw)).toEqual(["not json", undefined]);
  });
});

describe("AC6: prompts are normalised at load and sent normalised", () => {
  it("AC6: an agent's prompt file is loaded normalised (BOM, edge blank lines, NFC)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agboss-151-"));
    writeFileSync(join(dir, "writer.prompt.md"), "\uFEFF\n\n  Cafe\u0301 rules\n\n\tstep\n\n");
    @Agent({
      name: "writer-agent",
      description: "Writes",
      model: "local/llama",
      promptUrls: [join(dir, "writer.prompt.md")],
    })
    class Writer {}
    @Workflow({
      name: "normalised-workflow",
      version: "1",
      flow: [start(Start).returns(WorkflowStartTextDto).toAgent(Writer).toFinish(Finish)],
      defaults: {
        models: { temperature: 0 },
        router: { model: "typesafe/jev-1.13" },
      },
      uncompactedTurns: 1,
    })
    class Normalised implements WorkflowDefinition {
      settings(): WorkflowSettings {
        return WorkflowSettings.builder().build();
      }
    }

    const text = (await workflowOf(Normalised)).prompts["writer-agent"] ?? "";

    expect(text).toBe("  Caf\u00e9 rules\n\n\tstep");
  });
});
