/**
 * #261 PR 4 (AC12): the `defaults` cascade application → workflow → component, merged field by
 * field — the most specific level that sets a field wins; `defaults.router.model` and
 * `defaults.guardrail.model` are separate; no model anywhere → `[router.no-model]` /
 * `[guardrail.no-model]`; `agboss describe` shows where each value came from.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { cascadeDefaults, defaultSourceOf, DefaultsLevel } from "../../src/config/defaults.js";
import type { Class } from "../../src/components/injection.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  GraphRuleError,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type WorkflowDefaults,
} from "../../src/index.js";
import type { AssembledWorkflow } from "../../src/workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { route, start } from "../helpers/flow.js";

@WorkflowStart({
  name: "ask-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
class AskWorkflowStart {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
class AnswerWorkflowFinish {}

@Agent({
  name: "helper-agent",
  description: "Answers",
  prompt: "Answer.",
  model: "test/helper",
  maxTokens: 512,
})
class HelperAgent {}

/** A model router without its own model: it takes `defaults.router.model`. */
@Router({
  name: "ask-router",
  description: "Sends the question on",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who answers.",
  input: { message: WorkflowStartTextDto },
  routes: [{ prompt: "Any question", target: HelperAgent }],
})
class AskRouter {}

/** A router with its own model: it wins over every level. */
@Router({
  name: "own-router",
  description: "Sends the question on",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-own",
  prompt: "Pick who answers.",
  input: { message: WorkflowStartTextDto },
  routes: [{ prompt: "Any question", target: HelperAgent }],
})
class OwnRouter {}

const flowThrough = (router: Class) => [
  start(AskWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toRouter(router)
    .chooseOne(route(HelperAgent).toFinish(AnswerWorkflowFinish)),
];

const guards = {
  input: { prompt_injection: { threshold: 0.7, refusal: "No." } },
  output: { pii: { threshold: 0.7, refusal: "Withheld.", model: "typesafe/jev-pii" } },
};

/** Sets only `history.limit` and `models.temperature`: the rest comes from the application. */
@Workflow({
  name: "ask-workflow",
  version: "1.0.0",
  flow: flowThrough(AskRouter),
  defaults: { models: { temperature: 0.3 }, history: { limit: 7 } },
  guards,
})
class AskWorkflow {}

const applicationDefaults: WorkflowDefaults = {
  models: { temperature: 0, maxTokens: 2048 },
  router: { model: "typesafe/jev-application" },
  guardrail: { model: "typesafe/jev-guardrail" },
  tools: { maxToolCalls: 5 },
  history: { limit: 3, summaries: 2 },
};

@Application({
  name: "ask-application",
  version: "1.0.0",
  workflows: [AskWorkflow],
  defaults: applicationDefaults,
  budgets: TEST_BUDGETS,
})
class AskApplication {}

/** Sets its own router model, over the application's. */
@Workflow({
  name: "own-defaults-workflow",
  version: "1.0.0",
  flow: flowThrough(OwnRouter),
  defaults: { router: { model: "typesafe/jev-workflow" }, history: { limit: 1 } },
})
class OwnDefaultsWorkflow {}

@Application({
  name: "own-defaults-application",
  version: "1.0.0",
  workflows: [OwnDefaultsWorkflow],
  defaults: applicationDefaults,
  budgets: TEST_BUDGETS,
})
class OwnDefaultsApplication {}

/** A router model and no guardrail model anywhere. */
@Workflow({ name: "bare-workflow", version: "1.0.0", flow: flowThrough(AskRouter), guards })
class BareWorkflow {}

@Application({
  name: "router-only-application",
  version: "1.0.0",
  workflows: [BareWorkflow],
  defaults: { router: { model: "typesafe/jev-application" } },
  budgets: TEST_BUDGETS,
})
class RouterOnlyApplication {}

@Application({
  name: "bare-application",
  version: "1.0.0",
  workflows: [BareWorkflow],
  budgets: TEST_BUDGETS,
})
class BareApplication {}

const assembled = async (application: Class): Promise<AssembledWorkflow> => {
  const [workflow] = (await applicationOf(application)).workflows;
  if (workflow === undefined) throw new Error("no workflow");
  return workflow;
};

async function violationsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError))
    throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => `[${found.code}] ${found.message}`);
}

describe("#261 AC12: cascade", () => {
  it("merged field by field: the workflow's fields over the application's, the rest from it", async () => {
    const { config } = await assembled(AskApplication);
    expect(config.defaults.models).toMatchObject({ temperature: 0.3, maxTokens: 2048 });
    expect(config.defaults.history).toEqual({ limit: 7, summaries: 2 });
    expect(config.defaults.tools).toEqual({ maxToolCalls: 5 });
  });

  it("the component's own field wins over both levels", async () => {
    const { config } = await assembled(AskApplication);
    expect(config.agents["helper-agent"]?.maxTokens).toBe(512);
  });

  it("a router without a model takes defaults.router.model of the application", async () => {
    expect((await assembled(AskApplication)).routers.map((router) => router.model)).toEqual([
      "typesafe/jev-application",
    ]);
  });

  it("a router's own model wins; the workflow's defaults win over the application's", async () => {
    const workflow = await assembled(OwnDefaultsApplication);
    expect(workflow.routers.map((router) => router.model)).toEqual(["typesafe/jev-own"]);
    expect(workflow.config.defaults.router?.model).toBe("typesafe/jev-workflow");
  });

  it("nothing set → the framework's built-in", () => {
    expect(cascadeDefaults(undefined, undefined)).toBeUndefined();
    expect(cascadeDefaults({ history: { limit: 2 } }, undefined)).toEqual({
      history: { limit: 2 },
    });
    expect(cascadeDefaults(undefined, { tools: { maxToolCalls: 1 } })).toEqual({
      tools: { maxToolCalls: 1 },
    });
  });

  it("where a default came from: the most specific level that sets it, else none (built-in)", () => {
    const levels = {
      application: { name: "ask-application", defaults: applicationDefaults },
      workflow: { name: "ask-workflow", defaults: { history: { limit: 7 } } },
    };
    expect(defaultSourceOf(levels, "history", "limit")).toEqual({
      level: DefaultsLevel.Workflow,
      name: "ask-workflow",
    });
    expect(defaultSourceOf(levels, "history", "summaries")).toEqual({
      level: DefaultsLevel.Application,
      name: "ask-application",
    });
    expect(defaultSourceOf(levels, "flow", "maxPathDepth")).toBeUndefined();
  });

  it("agboss describe shows each router's model and where it came from", async () => {
    const own = describeWorkflow(await assembled(OwnDefaultsApplication)).join("\n");
    const inherited = describeWorkflow(await assembled(AskApplication)).join("\n");
    expect(own).toContain("own-router  decisions typesafe/jev-own (own)");
    expect(inherited).toContain(
      "ask-router  decisions typesafe/jev-application (defaults.router.model of ask-application)",
    );
  });

  it("agboss describe shows each agent's model settings and where they came from", async () => {
    const lines = describeWorkflow(await assembled(AskApplication));
    expect(lines).toContain(
      "    defaults: temperature 0.3 (ask-workflow) · maxTokens 512 (own) · history 7 (ask-workflow)",
    );
  });
});

describe("#261 AC12: router and guardrail models separate", () => {
  it("a guard takes defaults.guardrail.model, never defaults.router.model; its own model wins", async () => {
    const { config } = await assembled(AskApplication);
    expect(config.guards?.input?.prompt_injection?.model).toMatchObject({
      model: "typesafe/jev-guardrail",
    });
    expect(config.guards?.output?.pii?.model).toMatchObject({ model: "typesafe/jev-pii" });
  });

  it("no guardrail model anywhere → [guardrail.no-model], though defaults.router.model is set", async () => {
    expect(await violationsOf(RouterOnlyApplication)).toEqual([
      "[guardrail.no-model] bare-workflow: prompt_injection has no model — set model or defaults.guardrail.model",
    ]);
  });

  it("no router model anywhere → [router.no-model]", async () => {
    expect(await violationsOf(BareApplication)).toEqual([
      "[guardrail.no-model] bare-workflow: prompt_injection has no model — set model or defaults.guardrail.model",
      "[router.no-model] bare-workflow: ask-router uses DecidedBy.Model but has no model — set model or defaults.router.model",
    ]);
  });
});
