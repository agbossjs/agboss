import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeWorkflow } from "../src/describe/describe-workflow.js";
import { workflowOf } from "../src/testing/index.js";
import { defineTool } from "../src/tools/index.js";
import { resolveTools, type AssembledWorkflow } from "../src/workflow.js";
import { Greetings } from "./components/fixture/components.js";
import { TestWorkflow } from "./fixtures/test-workflow/test.workflow.js";
import { HistoryOfferWorkflow } from "./flow/fixtures/history.fixture.js";
import { PolishWorkflow, StoryWorkflow } from "./flow/fixtures/review.fixture.js";

const test = await workflowOf(TestWorkflow);
const greetings = await workflowOf(Greetings);
const story = await workflowOf(StoryWorkflow);
const polish = await workflowOf(PolishWorkflow);
const history = await workflowOf(HistoryOfferWorkflow);

const after = (lines: readonly string[], start: string): string[] => {
  const i = lines.findIndex((line) => line.startsWith(start));
  const next = lines.findIndex((line, j) => j > i && /^ {2}\S/.test(line));
  return lines.slice(i, next < 0 ? undefined : next);
};

describe("describe a workflow", () => {
  it("AC1: which agent can use which tool, with its kind and constructor dependencies — no keys, no network", () => {
    const lines = after(describeWorkflow(greetings), "  greeter-agent  ");

    expect(
      lines.some((l) => l.includes("· greet (local) ← Greeter (GREETING, ROUTER_FACTORY)")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("· read_file (MCP files)"))).toBe(true);
    expect(after(describeWorkflow(test), "  coder-agent  ")).toContain("    tools: none");
  });

  it("AC1: marks tools that wait for an approval when the pause seam is on", () => {
    const resolvedGreetingsTools = Array.isArray(greetings.tools)
      ? greetings.tools
      : (greetings.tools as any)({});
    const paused: AssembledWorkflow = {
      ...greetings,
      tools: [
        { ...resolvedGreetingsTools[0], channel: "terminal-user-channel" },
        ...resolvedGreetingsTools.slice(1),
      ],
    };

    expect(
      describeWorkflow(paused).some((l) =>
        l.includes("· greet (channel:terminal-user-channel, local, uses channel)"),
      ),
    ).toBe(true);
    expect(describeWorkflow(paused)).toContain(
      "pause     on — tools with channel wait for external signal",
    );
  });

  it("AC2: settings of the workflow and of each agent; the profile in the header", () => {
    const lines = describeWorkflow(test);

    expect(lines[0]).toMatch(/^test-workflow 1\.0\.0 · config [0-9a-f]{8}$/);
    expect(lines).toContain("guards    input: prompt_injection ≥0.7 · output: pii ≥0.7");
    expect(lines).toContain("memory    raw turns only");
    expect(
      lines.some((l) =>
        l.startsWith(
          "  researcher-agent  test/researcher · reasoning model decides · no output ceiling · history 5 turns",
        ),
      ),
    ).toBe(true);
    expect(
      after(lines, "  coder-agent  ").some((l) =>
        l.includes("limits: modelCalls 12 (default) · toolCalls 8"),
      ),
    ).toBe(true);
    expect(lines).toContain("limits    steps 1–2 (maxSteps 9) · day no daily cap");
    expect(describeWorkflow(test, "fast")[0]).toMatch(
      /^test-workflow 1\.0\.0 \(profile fast\) · config [0-9a-f]{8}$/,
    );
  });

  it("#272: the flow in the path grammar, one call per line; #270 AC18: each node's inputs with producers", () => {
    const lines = describeWorkflow(test);
    const section = (name: string, next: string): string[] =>
      lines.slice(lines.indexOf(name), lines.indexOf(next));

    expect(section("flow", "inputs")).toEqual([
      "flow",
      "  start(TestChat)",
      "    .returns(WorkflowStartTextDto)",
      "    .toRouter(MainRouter)",
      "    .chooseOne(",
      "      route(NoAnswer),",
      "      route(Researcher)",
      "        .toFinish(TestAnswer),",
      "      route(Coder)",
      "        .toFinish(TestAnswer)",
      "    )",
    ]);
    expect(section("inputs", "routers")).toEqual([
      "inputs",
      "  coder-agent ← message: chat-workflow-start",
      "  main-router ← message: chat-workflow-start",
      "  researcher-agent ← message: chat-workflow-start",
    ]);
  });

  it("#271 M2, #299: each value written { about }, in the flow too, and each field's producers", () => {
    const lines = describeWorkflow(story);
    const section = (name: string, next: string): string[] =>
      lines.slice(lines.indexOf(name), lines.indexOf(next));

    expect(section("about", "routers")).toEqual([
      "about",
      "  story-reviewer-agent → ApprovalDto { about: DraftDto }",
      "  story-reviewer-agent → DraftChangesDto { about: DraftDto }",
    ]);
    expect(lines).toEqual(
      expect.arrayContaining([
        "    .returns(oneOf(ApprovalDto, DraftChangesDto))",
        "      caseOf(DraftChangesDto, { about: DraftDto })",
      ]),
    );
    expect(lines).toContain(
      "  publisher-agent ← draft: story-writer-agent, approval: story-reviewer-agent",
    );
    expect(describeWorkflow(polish)).toEqual(
      expect.arrayContaining([
        "  critique-action → listOf(CritiqueDto) { about: DraftDto }",
        "    .returns(listOf(CritiqueDto), { about: DraftDto })",
      ]),
    );
    expect(describeWorkflow(test)).not.toContain("about");
  });

  it("#299 S56: a historyOf field says so, with its limit", () => {
    expect(describeWorkflow(history)).toEqual(
      expect.arrayContaining([
        "  review-draft-action ← draft: draft-editor-agent | first-draft-agent (latest, historyOf, limit 2)",
        "  draft-history-workflow-finish ← drafts: draft-editor-agent | first-draft-agent (latest, historyOf)",
      ]),
    );
  });

  it("AC3: tools nobody can use, and tools an agent names but the catalog lacks", () => {
    const extra = defineTool({
      name: "extra",
      description: "Unused.",
      input: z.object({}),
      output: z.string(),
      run: () => Promise.resolve(""),
    });
    const coder = test.config.agents["coder-agent"];
    if (coder === undefined) throw new Error("the test workflow has a coder");
    const workflow: AssembledWorkflow = {
      ...test,
      tools: (services) => [...resolveTools(test, services), extra],
      config: {
        ...test.config,
        agents: { ...test.config.agents, "coder-agent": { ...coder, tools: ["ghost"] } },
      },
    };

    const lines = describeWorkflow(workflow);

    expect(lines.at(-1)).toBe("unassigned tools: extra");
    expect(after(lines, "  coder-agent  ")).toContain("    · ghost (not in the catalog)");
  });
  it("AC3 (#97): each agent shows its output ceiling; reasoning unset is the provider's (#151)", () => {
    const coder = test.config.agents["coder-agent"];
    if (coder === undefined) throw new Error("the test workflow has a coder");
    const chat = { temperature: 0, maxTokens: test.config.defaults.models.maxTokens };
    const workflow: AssembledWorkflow = {
      ...test,
      config: {
        ...test.config,
        defaults: { ...test.config.defaults, models: chat },
        agents: {
          ...test.config.agents,
          "coder-agent": { ...coder, maxTokens: 4000, thinking: "none" },
        },
      },
    };
    const lines = describeWorkflow(workflow);

    expect(
      lines.some(
        (l) =>
          l.startsWith("  researcher-agent") &&
          l.includes("no output ceiling") &&
          l.includes("reasoning the provider's"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.startsWith("  coder-agent") &&
          l.includes("max 4000 tokens") &&
          l.includes("reasoning off"),
      ),
    ).toBe(true);
  });
});
