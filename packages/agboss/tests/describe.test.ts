import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeWorkflow } from "../src/describe/describe-workflow.js";
import { workflowOf } from "../src/testing/workflow-of.js";
import { defineTool } from "../src/tools/index.js";
import { type AssembledWorkflow } from "../src/workflow.js";
import { Greetings } from "./components/fixture/components.js";
import { TestWorkflow } from "./fixtures/test-workflow/test.workflow.js";
import { HistoryOfferWorkflow } from "./flow/fixtures/history.fixture.js";
import { PolishWorkflow, StoryWorkflow } from "./flow/fixtures/review.fixture.js";
import { resolveTools } from "../src/workflow.js";

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
      lines.some((l) => l.includes("· greet-tool (local) ← Greeter (GREETING, DecisionModel)")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("· read-file-tool (local)"))).toBe(true);
    expect(after(describeWorkflow(test), "  coder-agent  ")).toContain("    tools: none");
  });

  it("AC1: marks tools that wait for an approval when the pause seam is on", () => {
    const resolvedGreetingsTools = Array.isArray(greetings.tools)
      ? greetings.tools
      : (greetings.tools as any)({});
    const paused: AssembledWorkflow = {
      ...greetings,
      tools: [
        { ...resolvedGreetingsTools[0], approval: "terminal-tool-approval" },
        ...resolvedGreetingsTools.slice(1),
      ],
    };

    expect(
      describeWorkflow(paused).some((l) =>
        l.includes("· greet-tool (approval:terminal-tool-approval, local, waits for approval)"),
      ),
    ).toBe(true);
    expect(describeWorkflow(paused)).toContain(
      "pause     on — tools with an approval wait for external signal",
    );
  });

  it("AC2: settings of the workflow and of each agent; the profile in the header", () => {
    const lines = describeWorkflow(test);

    expect(lines[0]).toMatch(/^test-workflow 1\.0\.0 · config [0-9a-f]{8}$/);
    expect(lines).toContain(
      '  prompt-injection-guardrail — input ≥0.7 · typesafe/jev-1.13 (defaults.guardrail) · refusal: "I can\'t help with that request." · on coder-agent, researcher-agent, main-router',
    );
    expect(lines).toContain(
      '  personal-data-guardrail — output ≥0.7 · typesafe/jev-1.13 (defaults.guardrail) · refusal: "Withheld." · on coder-agent, researcher-agent',
    );
    expect(lines).toContain("memory    window only (no summaries)");
    expect(
      lines.some((l) =>
        l.startsWith(
          "  researcher-agent  test/researcher · reasoning model decides · no output ceiling · uncompactedTurns 5",
        ),
      ),
    ).toBe(true);
    expect(
      after(lines, "  coder-agent  ").some((l) =>
        l.includes("limits: modelCalls 12 (default) · toolCalls 8"),
      ),
    ).toBe(true);
    const limits = lines.indexOf("limits");
    expect(lines.slice(limits, limits + 8)).toEqual([
      "limits",
      "  maxSteps 9 (default: (agents + routers + actions + external tasks) × 3) · steps 1–2",
      "  maxVisits main-router 10",
      "  Worst case of one chat-workflow-start call",
      "    workflow executions  1  1 test-workflow",
      "    at the same time     1  1 test-workflow",
      "    steps                2  2 in test-workflow (longest path)",
      "    nesting depth        1  test-workflow",
    ]);
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
      "  onStart(TestChat)",
      "    .toRouter(MainRouter)",
      "    .onRoute(toFinish(NoAnswer))",
      "    .onRoute(toAgent(Researcher)",
      "      .toFinish(TestAnswer))",
      "    .onRoute(toAgent(Coder)",
      "      .toFinish(TestAnswer))",
    ]);
    expect(section("inputs", "routers")).toEqual([
      "inputs",
      "  coder-agent ← message: chat-workflow-start",
      "  main-router ← message: chat-workflow-start",
      "  researcher-agent ← message: chat-workflow-start",
    ]);
  });

  it("#271 M2, #1277: each field's producers, the flow as written; no about section", () => {
    const lines = describeWorkflow(story);

    expect(lines).not.toContain("about");
    expect(lines).toEqual(expect.arrayContaining(["    .toOneOf(["]));
    expect(lines).toContain(
      "  publisher-agent ← draft: story-writer-agent, approval: story-reviewer-agent",
    );
    expect(describeWorkflow(polish)).toEqual(expect.arrayContaining(["flow"]));
  });

  it("#299 S56: a historyOf field says so, with its maxPrevious", () => {
    expect(describeWorkflow(history)).toEqual(
      expect.arrayContaining([
        "  review-draft-action ← draft: draft-editor-agent | first-draft-agent (latest, historyOf, maxPrevious 2)",
        "  draft-history-action ← drafts: draft-editor-agent | first-draft-agent (latest, historyOf)",
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
