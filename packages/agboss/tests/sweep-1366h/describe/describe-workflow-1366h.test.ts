/**
 * #1366: `describeWorkflow` prints exactly the routers (model or code, with `maxVisits` only when
 * set), the children, the agents (compaction, description, knowledge bases, tools, the unassigned
 * tools) of the workflow, builds its tools without calling a router and with the app's environment.
 */
import { describe, expect, it } from "vitest";
import {
  describeServices,
  describeServicesWith,
  describeWorkflow,
} from "../../../src/describe/describe-workflow.js";
import { NO_ENVIRONMENT_VALUES } from "../../../src/environments/resolve.js";
import { workflowOf } from "../../../src/testing/workflow-of.js";
import type { AssembledWorkflow } from "../../../src/workflow.js";
import { Greetings } from "../../components/fixture/components.js";
import { CreditWorkflow } from "../../flow/fixtures/credit.fixture.js";
import { BatchWorkflow } from "../../flow/runtime/fixtures/tree-batch.workflow.js";
import { TestWorkflow } from "../../fixtures/test-workflow/test.workflow.js";

/** The lines of one section: after its header, up to the next unindented line. */
const section = (lines: readonly string[], header: string): string[] => {
  const from = lines.indexOf(header);
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((line) => !line.startsWith(" "));
  return end < 0 ? rest : rest.slice(0, end);
};

describe("describe a workflow: routers", () => {
  it("a decisions router and a code router, nothing else - no maxVisits where none is set", async () => {
    const lines = describeWorkflow(await workflowOf(CreditWorkflow));

    expect(section(lines, "routers")).toEqual([
      "  desk-router  decisions typesafe/jev-1.13 (own) — Sends an order to the intake, ends on anything else",
      "  credit-limit-router  code — Sends large orders for approval, charges the rest",
    ]);
  });

  it("a chat-model router is `llm`, with its maxVisits", async () => {
    const bundle = await workflowOf(TestWorkflow);
    const chat: AssembledWorkflow = {
      ...bundle,
      routers: bundle.routers.map((router) => ({ ...router, model: "test/router" })),
    };

    expect(section(describeWorkflow(chat), "routers")).toEqual([
      "  main-router  llm test/router (own) · maxVisits 10 — Sends the message to an agent, or ends",
    ]);
    expect(section(describeWorkflow(bundle), "routers")).toEqual([
      "  main-router  decisions typesafe/jev-1.13 (own) · maxVisits 10 — Sends the message to an agent, or ends",
    ]);
  });
});

describe("describe a workflow: children, agents and tools", () => {
  it("the children section lists each launch; a workflow without children has none", async () => {
    const parent = describeWorkflow(await workflowOf(BatchWorkflow, []));
    const alone = describeWorkflow(await workflowOf(CreditWorkflow));

    expect(parent).toContain("children");
    expect(section(parent, "children")).toEqual([
      "  batch-workflow-start → task-workflow per item: task-workflow-start (TaskDto)",
    ]);
    expect(alone).not.toContain("children");
  });

  it("an agent without a compaction, knowledge base or tool prints exactly its lines", async () => {
    const lines = describeWorkflow(await workflowOf(CreditWorkflow));

    expect(section(lines, "agents").slice(0, 6)).toEqual([
      "  approval-agent  moonshotai/kimi-k2.6 · reasoning the provider's · max 8192 tokens · uncompactedTurns 5",
      "    Approves a large order",
      "    limits: modelCalls 12 (default) · toolCalls 20 (default)",
      "    defaults: temperature 0 (built-in) · maxTokens 8192 (built-in) · uncompactedTurns 5 (built-in)",
      "    tools: none",
      "  order-intake-agent  moonshotai/kimi-k2.6 · reasoning the provider's · max 8192 tokens · uncompactedTurns 5",
    ]);
  });

  it("a tool without constructor dependencies prints no arrow, with or without the dependency table", async () => {
    const bundle = await workflowOf(TestWorkflow);
    const { toolDependencies: _dropped, ...withoutTable } = bundle;
    const tool =
      "    · current-time-tool (local) — Current date and time in an IANA time zone (default UTC). · maxResultSize 128 KB (built-in)";

    expect(describeWorkflow(bundle)).toContain(tool);
    expect(describeWorkflow(withoutTable)).toContain(tool);
  });

  it("an agent config without a tools list prints `tools: none`; a set toolCalls is not marked default", async () => {
    const bundle = await workflowOf(TestWorkflow);
    const agents = Object.fromEntries(
      Object.entries(bundle.config.agents).map(([name, { tools: _tools, ...agent }]) => [
        name,
        agent,
      ]),
    );
    const lines = describeWorkflow({ ...bundle, config: { ...bundle.config, agents } });

    expect(lines.filter((line) => line.startsWith("    tools:"))).toEqual([
      "    tools: none",
      "    tools: none",
    ]);
    expect(lines).toContain("    limits: modelCalls 12 (default) · toolCalls 8");
    expect(lines.at(-1)).toBe("unassigned tools: current-time-tool");
  });

  it("tools nobody uses are listed by name, joined by a comma; none otherwise", async () => {
    const bundle = await workflowOf(Greetings);
    const unused: AssembledWorkflow = {
      ...bundle,
      config: {
        ...bundle.config,
        agents: Object.fromEntries(
          Object.entries(bundle.config.agents).map(([name, agent]) => [
            name,
            { ...agent, tools: [] },
          ]),
        ),
      },
    };

    expect(describeWorkflow(bundle).at(-1)).toBe("unassigned tools: none");
    expect(describeWorkflow(unused).at(-1)).toBe("unassigned tools: greet-tool, read-file-tool");
  });
});

describe("describe services", () => {
  it("a router that is never called: it is named, and calling it rejects", async () => {
    const router = describeServices.router("some-router");

    expect(router.name).toBe("some-router");
    await expect(router.route({ messages: [], options: [] } as never)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it("with no environment the services are the empty ones; with one its name and values reach the tools", () => {
    const environment = { name: "stage", values: NO_ENVIRONMENT_VALUES, fields: {} };

    expect(describeServicesWith(undefined)).toBe(describeServices);
    expect(describeServices.contexts?.application.environmentName).toBe("dev");
    const given = describeServicesWith(environment);
    expect(given.contexts?.application.environmentName).toBe("stage");
    expect(given.contexts?.application.environment).toStrictEqual(NO_ENVIRONMENT_VALUES);
    expect(given.router).toBe(describeServices.router);
  });
});
