/**
 * #237: `agboss generate … --force` regenerates a component and keeps what is wired into it — tools,
 * knowledge bases, MCP tools — and the conflict message never suggests a command that loses wiring.
 * A project from `agboss create`, driven through the `agboss` binary as a user would.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { specFromFlags } from "../../src/scaffold/flags.js";
import type { WorkflowSpec } from "../../src/scaffold/plan.js";
import { planProject } from "../../src/scaffold/project.js";
import { applyChanges } from "../../src/scaffold/write.js";
import { expectStaticChecks, agbossIn, tscOf, vitestOf, type Ran } from "./project-checks.js";

const tmp = new URL("../../.scaffold-tmp", import.meta.url).pathname;
const project = join(tmp, `forced-${String(process.pid)}`);
const workflow = "desk-workflow";
const agent = "src/desk/agents/billing.agent.ts";
const read = (path: string): string => readFileSync(join(project, path), "utf8");
const agboss = (...args: string[]): Ran => agbossIn(project, args);
const generate = (...args: string[]): Ran => agboss("generate", ...args, "--workflow", workflow);

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("#237: --force keeps the wiring", () => {
  it("AC1: agent with a tool, a knowledge base and an MCP tool, regenerated with --force → all still wired, the project green", async () => {
    mkdirSync(tmp, { recursive: true });
    const spec = specFromFlags("desk", {
      yes: true,
      agents: "answerer-agent:Answers questions",
      tools: "answerer-agent:search-orders-tool",
    }) as WorkflowSpec;
    await applyChanges(project, { create: planProject(spec), modify: [] });
    for (const step of [
      generate("agent", "billing-agent", "--description", "Handles invoices"),
      generate("tool", "quote-tool", "--agent", "billing-agent"),
      generate("rag", "policies-rag", "--folder", "policies", "--agent", "billing-agent"),
      generate(
        "mcp",
        "tickets",
        "--command",
        "tickets-mcp",
        "--tool",
        "search",
        "--agent",
        "billing-agent",
      ),
    ])
      expect(step.ok, step.out).toBe(true);
    const wired = read(agent);

    const forced = generate(
      "agent",
      "billing-agent",
      "--description",
      "Bills customers",
      "--force",
      "--json",
    );

    expect(forced.ok, forced.out).toBe(true);
    const { warnings } = JSON.parse(forced.stdout) as { warnings: string[] };
    expect(warnings).toContain(`kept: ${agent}: tools [QuoteTool, TicketsSearchTool]`);
    expect(warnings).toContain(`kept: ${agent}: rag [PoliciesRag]`);
    const regenerated = read(agent);
    expect(regenerated).toContain('description: "Bills customers"');
    expect(regenerated).not.toBe(wired);
    expect(regenerated).toContain("tools: [QuoteTool, TicketsSearchTool]");
    expect(regenerated).toContain("rag: [{ use: PoliciesRag, mode: RagMode.Tool }]");
    expect(regenerated).toContain('import { QuoteTool } from "../tools/quote.tool.js";');
    expectStaticChecks(project, ["src"]);
    const tests = vitestOf(project);
    expect(tests.ok, tests.out).toBe(true);
    // the application of package.json (#268 AC1)
    expect(agboss("check").out).toContain("ok: src/desk.application.ts");
    const described = agboss("describe");
    expect(described.out).toMatch(
      /billing-agent .*\n\s+Bills customers\n\s+limits: .*\n\s+rag: policies-rag/,
    );
    expect(described.out).toContain("· quote-tool (local)");
    expect(described.out).toContain("· tickets-search-tool (MCP tickets)");
  }, 240_000);

  it("AC2: the conflict suggests --force, which keeps the wiring; wiring --force cannot keep is refused, --force --reset drops it", () => {
    const again = generate("agent", "billing-agent");
    expect(again.status, again.out).toBe(4);
    expect(again.out).toContain(
      "Nothing was written — rerun with --force to regenerate the files and keep the existing wiring",
    );
    expect(again.out).not.toContain("--reset");

    // `agboss create`'s tool injects ApiService through its constructor, which the template rewrites
    const tool = "src/desk/tools/search-orders.tool.ts";
    const before = read(tool);
    const refused = generate("tool", "search-orders-tool", "--agent", "answerer-agent", "--force");
    expect(refused.status, refused.out).toBe(4);
    expect(refused.out).toContain(
      `${tool}: deps [ApiService] cannot be kept: the regenerated file rewrites the constructor they go with. Nothing was written`,
    );
    expect(read(tool)).toBe(before);

    const reset = generate(
      "tool",
      "search-orders-tool",
      "--agent",
      "answerer-agent",
      "--force",
      "--reset",
    );
    expect(reset.ok, reset.out).toBe(true);
    expect(read(tool)).not.toContain("ApiService");
    expect(read("src/desk/agents/answerer.agent.ts")).toContain("tools: [SearchOrdersTool]");
    expect(tscOf(project).out).toBe("");
    expect(agboss("help", "generate").out).toContain("--reset");
  }, 120_000);
});
