/**
 * #93 AC1 / AC2: a generated project compiles, passes its own tests and the framework's lint rules, and
 * its workflow assembles — right after `create` and after each `generate`. Generated inside the monorepo
 * (its installed dependencies); a real `npm install` is the manual check M1.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { specFromFlags } from "../../src/scaffold/flags.js";
import { FINISH_ROUTE_TEXT } from "../../src/scaffold/flow-files.js";
import { planGenerate } from "../../src/scaffold/generate.js";
import type { WorkflowSpec } from "../../src/scaffold/plan.js";
import { planProject } from "../../src/scaffold/project.js";
import { applyChanges } from "../../src/scaffold/write.js";
import { expectStaticChecks, agbossIn, lintOf, vitestOf } from "./project-checks.js";

const tmp = new URL("../../.scaffold-tmp", import.meta.url).pathname;
const project = join(tmp, `desk-${String(process.pid)}`);

/** tsc, the framework's ESLint rules, prettier, the project's own tests, `agboss describe` of its application. */
function check(): string {
  // `agboss check` writes the generated types the project compiles against (#272 S7); the
  // application is package.json's (#268 AC1)
  const checked = agbossIn(project, ["check"]);
  expect(checked.ok, checked.out).toBe(true);
  expectStaticChecks(project, ["src"]);
  // #388 AC1: the project's own `npm run lint` passes, on its generated config
  const lint = lintOf(project);
  expect(lint.ok, lint.out).toBe(true);
  const tests = vitestOf(project);
  expect(tests.ok, tests.out).toBe(true);
  const describeOut = agbossIn(project, ["describe"]);
  expect(describeOut.ok, describeOut.out).toBe(true);
  return describeOut.out;
}

/** How `agboss describe` prints the generated flow with these agents, one call per line. */
const FLOW_OF = (agents: readonly string[]): string =>
  [
    "  start(TextWorkflowStart)",
    "    .returns(WorkflowStartTextDto)",
    "    .toRouter(MainRouter)",
    "    .chooseOne(",
    agents
      .map((agent) => `      route(${agent})\n        .toFinish(TextWorkflowFinish)`)
      .join(",\n"),
    "    )",
  ].join("\n");

const scripts = (): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("agboss create / agboss generate end to end", () => {
  it("AC1: create → a project that compiles, passes its tests and lint, and whose workflow assembles", async () => {
    mkdirSync(tmp, { recursive: true });
    const spec = specFromFlags("desk", {
      yes: true,
      agents: "triage-agent:Sorts requests,answerer-agent:Answers questions",
      tools: "answerer-agent:search-orders-tool",
      mcp: `filesystem:${tmp}`,
      rag: "notes",
    }) as WorkflowSpec;
    await applyChanges(project, { create: planProject(spec), modify: [] });

    const out = check();

    // #305 AC3: the coding agents' files; the skills create wrote are current for agboss check
    for (const file of ["AGENTS.md", "CLAUDE.md", ".claude/skills/agboss/SKILL.md"])
      expect(existsSync(join(project, file)), file).toBe(true);
    expect(agbossIn(project, ["check"]).out).not.toContain("skills:");
    expect(out).toContain("desk-workflow 0.1.0");
    // #272: the generated workflow is one path — start → main router → an agent → the finish
    expect(out).toContain(FLOW_OF(["TriageAgent", "AnswererAgent"]));
    expect(out).toContain("  maxSteps 9 (default: (agents + routers) × 3) · steps 2–2");
    // create wires the MCP server and the knowledge base into the first agent
    expect(out).toMatch(
      /triage-agent .*\n\s+Sorts requests\n\s+limits: .*\n\s+rag: desk-notes-rag \(tool, k 3\)/,
    );
    expect(out).toContain("· search-orders-tool (local)");
    expect(out).toContain("· read-desk-files-tool (MCP desk-files)");
    // #107 AC2: files named by kind, the prompt next to its agent (no prompt parameter)
    for (const file of [
      "agents/answerer/answerer.agent.ts",
      "agents/answerer/answerer.prompt.md",
      "tools/search-orders.tool.ts",
      "tools/search-orders.tool.test.ts",
      "dto/search-orders-query.dto.ts",
      "dto/search-orders-result.dto.ts",
      "dto/file-read.dto.ts",
      "dto/file-content.dto.ts",
      "mcp/desk-files.mcp-server.ts",
      "mcp/read-desk-files.mcp-tool.ts",
      "rag/desk-notes.rag.ts",
      "workflow-starts/text.workflow-start.ts",
      "workflow-finishes/text.workflow-finish.ts",
    ]) {
      expect(existsSync(join(project, "src/desk", file)), file).toBe(true);
    }
    // #141 AC6: the start and the finish of a new workflow are TextWorkflowStart / TextWorkflowFinish
    const desk = (file: string): string => readFileSync(join(project, "src/desk", file), "utf8");
    expect(desk("workflow-starts/text.workflow-start.ts")).toContain(
      "export class TextWorkflowStart {}",
    );
    expect(desk("workflow-finishes/text.workflow-finish.ts")).toContain(
      "export class TextWorkflowFinish {}",
    );
    // #142: the main router of a new workflow is on the star's cycle, so it declares maxVisits
    expect(desk("routers/main/main.router.ts")).toContain("maxVisits: 3,");
    expect(
      readFileSync(join(project, "src/desk/agents/answerer/answerer.agent.ts"), "utf8"),
    ).not.toContain("prompt:");
    // #268 AC1: the application's path is set once in package.json; the scripts name no path
    expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8"))).toMatchObject({
      agboss: { application: "src/desk.application.ts" },
    });
    // #268 AC2: a run script names its start by its full name — it keeps working as workflows are added
    expect(scripts().chat).toBe("agboss chat --start desk-text-workflow-start");
    expect(scripts().run).toBe("agboss run --start desk-text-workflow-start");
    expect(scripts().types).toBe("agboss check");
    expect(scripts().lint).toBe("eslint .");
    expect(scripts()["rag:index"]).toBe("agboss rag index");
    // #135 AC12: the workflow test on testWith runs offline in the unit project; empty projects pass
    const unit = vitestOf(project, ["--project", "unit"]);
    expect(unit.ok, unit.out).toBe(true);
    expect(unit.out).toContain("desk.workflow.test.ts");
    expect(vitestOf(project, ["--project", "integration"]).ok).toBe(true);
    expect(vitestOf(project, ["--project", "suites"]).ok).toBe(true);
    expect(scripts().test).toBe("vitest run --project unit --project integration");
  }, 240_000);

  it("AC2: generate agent, router, tool, mcp, rag and workflow — each wired, the project still compiles and passes", async () => {
    const workflow = "desk-workflow";
    for (const plan of [
      () =>
        planGenerate(
          "agent",
          "billing-agent",
          { workflow, description: "Handles invoices" },
          project,
        ),
      () => planGenerate("tool", "refund-tool", { workflow, agent: "billing-agent" }, project),
      () =>
        planGenerate(
          "mcp",
          "tickets",
          { workflow, command: "tickets-mcp", tool: "search", agent: "billing-agent" },
          project,
        ),
      () =>
        planGenerate(
          "rag",
          "policies-rag",
          { workflow, folder: "policies", agent: "billing-agent" },
          project,
        ),
      () => planGenerate("router", "escalation-router", { workflow }, project),
      () => planGenerate("workflow", "onboarding-workflow", {}, project),
    ]) {
      await applyChanges(project, await plan());
    }

    const out = check();

    expect(out).toMatch(/billing-agent .*\n\s+Handles invoices/);
    // a new agent joins the router's choice — a route in the main router and in its chooseOne
    expect(out).toContain(FLOW_OF(["TriageAgent", "AnswererAgent", "BillingAgent"]));
    expect(readFileSync(join(project, "src/desk/routers/main/main.router.ts"), "utf8")).toContain(
      '{ prompt: "Handles invoices", target: BillingAgent }',
    );
    // #142 AC3: `agboss g router` writes maxVisits: 1, and the workflow still assembles (check above)
    expect(
      readFileSync(join(project, "src/desk/routers/escalation/escalation.router.ts"), "utf8"),
    ).toContain("maxVisits: 1,");
    expect(out).toContain("rag: policies-rag (tool, k 3)");
    expect(out).toContain("· refund-tool (local)");
    expect(out).toContain("· tickets-search-tool (MCP tickets)");
    // #141 AC3: a text-only MCP server tool replies with PlainTextDto
    expect(readFileSync(join(project, "src/desk/mcp/tickets.mcp-server.ts"), "utf8")).toContain(
      "output: PlainTextDto",
    );
    // #268 AC8: the new workflow is one more of the application, its files next to the first's
    expect(out).toContain("onboarding-workflow 0.1.0");
    expect(readFileSync(join(project, "src/desk.application.ts"), "utf8")).toContain(
      "workflows: [DeskWorkflow, OnboardingWorkflow]",
    );
    expect(existsSync(join(project, "src/onboarding/onboarding.workflow.test.ts"))).toBe(true);
    expect(scripts()["chat:onboarding"]).toBe("agboss chat --start onboarding-text-workflow-start");
  }, 240_000);

  it("AC2: rerunning generators with --force regenerates files and doubles no wiring", async () => {
    const workflow = "desk-workflow";
    const module = "src/desk/desk.workflow.ts";
    const read = (path: string): string => readFileSync(join(project, path), "utf8");
    const before = [module, "src/desk/routers/main/main.router.ts"].map(read);

    for (const [kind, name, options] of [
      ["agent", "billing-agent", { workflow, description: "Handles invoices, again" }],
      ["tool", "refund-tool", { workflow, agent: "billing-agent" }],
      ["rag", "policies-rag", { workflow, folder: "policies", agent: "billing-agent" }],
    ] as const) {
      const plan = await planGenerate(kind, name, options, project);
      await expect(applyChanges(project, plan)).rejects.toThrow("Nothing was written");
      await applyChanges(project, plan, { force: true });
    }

    expect([module, "src/desk/routers/main/main.router.ts"].map(read)).toEqual(before);
    expect(read("src/desk/routers/escalation/escalation.router.ts")).toContain(FINISH_ROUTE_TEXT);
    check();
  }, 240_000);
});
