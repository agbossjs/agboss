/**
 * #1366: the describe snapshot of a flow's nodes shows each agent's and router's settings as the
 * config resolves them — model, provider, reasoning, output ceiling, limits, tools, judges,
 * retries, instructions, PII policies, memory — the router's routes with their prompts, the
 * node's description and `maxVisits`; a node without one shows no such key.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { applicationOf } from "../../src/application/assemble.js";
import { DEFAULT_MAX_TOKENS } from "../../src/config/types.js";
import { nodesOf, type NodeSnapshot } from "../../src/describe/snapshot-nodes.js";
import type { AssembledWorkflow } from "../../src/workflow.js";
import { PiiPolicy } from "../../src/pii/pii-policy.decorator.js";
import { PiiAction, PiiKind, pii } from "../../src/pii/index.js";
import { OutlineWorkflow } from "../flow/fixtures/recursion.fixture.js";
import { NotesDeskApplication } from "../compaction/compaction.fixture.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { TestApplication } from "../fixtures/test-workflow/test.workflow.js";

const outlineApplication = async () => {
  @Application({
    name: "outline-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [OutlineWorkflow],
    budgets: TEST_BUDGETS,
  })
  class OutlineApplication {}
  return OutlineApplication;
};

const assembled = await applicationOf(TestApplication);
const [test] = assembled.workflows;
if (test === undefined) throw new TypeError("the test application lists one workflow");

const nodeNamed = (workflow: AssembledWorkflow, name: string): NodeSnapshot => {
  const found = nodesOf(workflow).find((node) => node.name === name);
  if (found === undefined) throw new Error(`${name} is not a node`);
  return found;
};

/** The test workflow with these agent settings and defaults. */
const withConfig = (
  models: object,
  agents: Record<string, object>,
  tools?: { maxToolCalls?: number },
): AssembledWorkflow => ({
  ...test,
  config: {
    ...test.config,
    defaults: {
      ...test.config.defaults,
      models: { ...test.config.defaults.models, ...models },
      ...(tools === undefined ? {} : { tools: { ...test.config.defaults.tools, ...tools } }),
    },
    agents: Object.fromEntries(
      Object.entries(test.config.agents).map(([name, settings]) => [
        name,
        { ...settings, ...agents[name] },
      ]),
    ),
  },
});

describe("#1366: an agent's settings as resolved", () => {
  it("its own reasoning, output ceiling, tools, judges and retries win over the defaults", () => {
    const workflow = withConfig(
      { thinking: "low", maxTokens: 900 },
      { "coder-agent": { thinking: "none", maxTokens: 4000, maxRetries: 2, judges: ["quality-judge"], tools: ["clock"] } },
      { maxToolCalls: 5 },
    );

    const coder = nodeNamed(workflow, "coder-agent").agent;
    const researcher = nodeNamed(workflow, "researcher-agent").agent;

    expect(coder).toMatchObject({
      model: "test/coder",
      reasoning: "off",
      maxTokens: 4000,
      maxToolCalls: 5,
      maxRetries: 2,
      judges: ["quality-judge"],
      tools: ["clock"],
    });
    expect(researcher).toMatchObject({ maxTokens: 900, maxRetries: 0, judges: [] });
    expect(researcher?.reasoning).not.toBe("provider");
    expect(researcher?.reasoning).not.toBe(coder?.reasoning);
  });

  it("no reasoning set anywhere is the provider's; no output ceiling set is the framework's", () => {
    const workflow = withConfig(
      { thinking: undefined, maxTokens: undefined },
      { "coder-agent": { thinking: undefined, maxTokens: undefined, tools: undefined } },
    );

    const coder = nodeNamed(workflow, "coder-agent").agent;

    expect(coder).toMatchObject({
      reasoning: "provider",
      maxTokens: DEFAULT_MAX_TOKENS,
      tools: [],
      rag: [],
      judges: [],
      maxRetries: 0,
    });
  });

  it("the provider of the model, the instructions as rendered, and the PII policies in effect", () => {
    const coder = nodeNamed(test, "coder-agent").agent;

    expect(coder?.provider).not.toBe("");
    expect(coder?.instructions).not.toBe("");
    expect(coder?.piiPolicies).toStrictEqual([]);
    expect(coder?.compaction).toBeUndefined();
    expect(coder).not.toHaveProperty("compaction");
  });

  it("an agent under a compaction names it", async () => {
    const notes = await applicationOf(NotesDeskApplication);
    const [workflow] = notes.workflows;
    if (workflow === undefined) throw new TypeError("one workflow");

    expect(nodeNamed(workflow, "note-agent").agent).toMatchObject({ compaction: "note-compaction" });
  });
});

describe("#1366: a node's own facts", () => {
  it("only an agent has agent settings and only a router router settings", () => {
    const nodes = nodesOf(test);
    const agentNames = nodes.filter((node) => "agent" in node).map((node) => node.name);
    const routerNames = nodes.filter((node) => "router" in node).map((node) => node.name);

    expect(agentNames.sort()).toStrictEqual(["coder-agent", "researcher-agent"]);
    expect(routerNames).toStrictEqual(["main-router"]);
  });

  it("a description and maxVisits only where declared", () => {
    const router = nodeNamed(test, "main-router");
    const coder = nodeNamed(test, "coder-agent");

    expect(router.description).toBe("Sends the message to an agent, or ends");
    expect(router.maxVisits).toBe(10);
    expect(coder.description).toBe("Writes, reviews and explains code");
    expect(coder).not.toHaveProperty("maxVisits");
    expect(nodesOf(test).filter((node) => !("description" in node))).not.toStrictEqual(nodesOf(test));
  });

  it("a model router: the model, its provider, its instructions and each route with its prompt", () => {
    const { router } = nodeNamed(test, "main-router");

    expect(router).toMatchObject({
      decidedBy: "model",
      model: "typesafe/jev-1.13",
      instructions: expect.stringContaining("Pick who handles the message."),
    });
    expect(router?.provider).not.toBe("");
    expect(router?.piiPolicies).toStrictEqual([]);
    expect(router?.routes.map((route) => [route.target, route.prompt])).toStrictEqual([
      ["no-answer-workflow-finish", "Stop without an answer: nothing to do"],
      ["researcher-agent", "Researcher work"],
      ["coder-agent", "Coder work"],
    ]);
  });
});

@PiiPolicy({
  name: "card-numbers-pii-policy",
  description: "Hides card numbers",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
class CardNumbersPolicy {}

class UndecoratedPolicy {
  readonly note = "has no @PiiPolicy declaration";
}

/** The test workflow with this PII assembly, per element. */
const withPii = (byElement: ReadonlyMap<string, readonly (abstract new () => unknown)[]>): AssembledWorkflow => ({
  ...test,
  pii: { ...test.pii, byElement } as never,
});

describe("#1366: the PII policies and the instructions of a node", () => {
  it("a workflow without a PII assembly lists no policies", () => {
    const workflow: AssembledWorkflow = { ...test, pii: undefined };

    expect(nodeNamed(workflow, "coder-agent").agent?.piiPolicies).toStrictEqual([]);
    expect(nodeNamed(workflow, "main-router").router?.piiPolicies).toStrictEqual([]);
  });

  it("an element's policies by their declared names; a policy class without a declaration by its class name", () => {
    const workflow = withPii(
      new Map([
        ["coder-agent", [CardNumbersPolicy, UndecoratedPolicy]],
        ["main-router", [CardNumbersPolicy]],
      ]),
    );

    expect(nodeNamed(workflow, "coder-agent").agent?.piiPolicies).toStrictEqual([
      "card-numbers-pii-policy",
      "UndecoratedPolicy",
    ]);
    expect(nodeNamed(workflow, "main-router").router?.piiPolicies).toStrictEqual(["card-numbers-pii-policy"]);
    expect(nodeNamed(workflow, "researcher-agent").agent?.piiPolicies).toStrictEqual([]);
  });

  it("an agent without a prompt text has empty instructions", () => {
    const workflow: AssembledWorkflow = { ...test, prompts: {} };

    expect(nodeNamed(workflow, "coder-agent").agent?.instructions).toBe("");
  });
});

describe("#1366: the routers of a node", () => {
  it("a router reads its own loaded texts, not another router's", () => {
    const [main] = test.routers;
    if (main === undefined) throw new TypeError("the test workflow has a model router");
    const other = { ...main, name: "other-router", model: "other/model", instructions: "Other instructions." };
    const workflow: AssembledWorkflow = { ...test, routers: [other, main] };

    expect(nodeNamed(workflow, "main-router").router).toMatchObject({
      model: "typesafe/jev-1.13",
      instructions: main.instructions,
    });
  });

  it("a model router that was never loaded is shown as decided by code, without a model", () => {
    const workflow: AssembledWorkflow = { ...test, routers: [] };

    expect(nodeNamed(workflow, "main-router").router).toMatchObject({ decidedBy: "code" });
    expect(nodeNamed(workflow, "main-router").router).not.toHaveProperty("model");
  });

  it("a code router: decided by code, its routes without a model, a prompt or a provider", async () => {
    const outline = await applicationOf(await outlineApplication());
    const [workflow] = outline.workflows;
    if (workflow === undefined) throw new TypeError("one workflow");

    const { router } = nodeNamed(workflow, "outline-depth-router");

    expect(router).toStrictEqual({
      decidedBy: "code",
      routes: [
        { target: "this-workflow", spawn: expect.anything(), failure: expect.anything() },
        { target: "outline-agent", spawn: expect.anything(), failure: expect.anything() },
      ],
    });
  });

  it("a node declared without a description shows none", async () => {
    const outline = await applicationOf(await outlineApplication());
    const [workflow] = outline.workflows;
    if (workflow === undefined) throw new TypeError("one workflow");
    const nodes = nodesOf(workflow);

    const lacking = nodes.filter((node) => !("description" in node)).map((node) => node.name);

    expect(lacking).toStrictEqual(["this-workflow"]);
    expect(nodes.filter((node) => "description" in node).every((node) => typeof node.description === "string")).toBe(true);
  });
});
