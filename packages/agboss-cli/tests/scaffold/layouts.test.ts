/**
 * #197: every generator kind on the shipped example's layout (#489: flow-patterns — two
 * applications, domain folders of kind folders, `tests/` mirroring `src/`): a new workflow listed in
 * the patterns' application, an agent, its tool, MCP server and knowledge base in that workflow, a
 * router and an OpenAPI tool in the hand-written credit domain — and reruns that never double the
 * wiring. The copy sits in `examples/` so the examples' lint rules apply to it.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planGenerate, type GenerateOptions } from "../../src/scaffold/generate.js";
import { applyChanges } from "../../src/scaffold/write.js";
import { FLOW_PATTERNS_CHECK } from "../fixtures/flow-patterns-check.js";
import { expectStaticChecks, agbossIn, repo, vitestOf } from "./project-checks.js";

const example = join(repo, "examples/flow-patterns");
const project = join(repo, "examples", `.scaffold-tmp-flow-patterns-${String(process.pid)}`);
const workflow = "onboarding-workflow";
const module = "src/workflows/onboarding/onboarding.workflow.ts";
const router = "src/routers/onboarding-main/onboarding-main.router.ts";
const credit = "credit-workflow";
const pets = new URL("../fixtures/openapi/pets.yaml", import.meta.url).pathname;
const text = (path: string): string => readFileSync(join(project, path), "utf8");

/** Each kind, as `agboss generate <kind> <full name> [options]` would plan it (#268 AC8). */
const KINDS: readonly (readonly [string, string, GenerateOptions])[] = [
  // the agent kinds need a model router's choice: the new workflow has one (credit's ends in a charge)
  ["workflow", "onboarding-workflow", {}],
  ["agent", "billing-agent", { workflow, description: "Handles invoices and refunds" }],
  ["tool", "refund-tool", { workflow, agent: "billing-agent" }],
  // a server the example's own tests really start: the filesystem server over its policies
  ["mcp", "tickets", { workflow, dir: join(project, "data/policies"), agent: "billing-agent" }],
  ["rag", "policies-rag", { workflow, folder: "policies", agent: "billing-agent" }],
  ["router", "escalation-router", { workflow: credit }],
  ["openapi", "pets", { workflow: credit, agent: "approval-agent", url: pets, operations: "getPet" }],
];
/** The kinds an agent's own wiring comes from: regenerated with --force, never doubled. */
const AGENT_WIRING = KINDS.filter(([kind]) => ["tool", "mcp", "rag"].includes(kind));

beforeAll(() => {
  // the copy resolves its dependencies from the repo's node_modules, as the example does
  cpSync(example, project, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|\.agboss)([\\/]|$)/.test(source),
  });
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("#489 AC2: agboss generate on flow-patterns' layout", () => {
  it("AC1: every kind lands next to its kind, wired, and the example stays green", async () => {
    for (const [kind, name, options] of KINDS)
      await applyChanges(project, await planGenerate(kind, name, options, project));
    writeFileSync(join(project, "tests/billing-check.test.ts"), FLOW_PATTERNS_CHECK);

    // targets resolved from the workflow module: its agents folder, its router, its finish
    expect(existsSync(join(project, "src/agents/billing/billing.agent.ts"))).toBe(true);
    // #272: the router's choice in the flow gets the agent's path, its routes the agent
    expect(text(module)).toMatch(
      /route\(OnboardingAssistantAgent\)\n {10}\.toFinish\(TextWorkflowFinish\),\n {8}route\(BillingAgent\)\n {10}\.toFinish\(TextWorkflowFinish\),\n/,
    );
    // the new route goes after the last one, one per line
    expect(text(router)).toMatch(
      /target: OnboardingAssistantAgent },\n {4}\{ prompt: "Handles invoices and refunds", target: BillingAgent \},\n {2}\],/,
    );
    // a hand-written domain (#474): its routers, its workflow's finish, its tools and their tests
    expect(text("src/credit/routers/escalation/escalation.router.ts")).toContain(
      'import { CreditWorkflowFinish } from "../../workflows/credit/credit.workflow-finish.js";',
    );
    expect(text("src/credit/agents/approval/approval.agent.ts")).toContain("GetPetTool");
    // tests where vitest looks (tests/**, mirroring src/), importing the tool where it is
    expect(existsSync(join(project, "src/tools/refund.tool.test.ts"))).toBe(false);
    expect(text("tests/tools/refund.tool.test.ts")).toContain(
      'import { RefundTool } from "../../src/tools/refund.tool.js";',
    );
    expect(text("tests/credit/tools/get-pet.tool.test.ts")).toContain(
      'import { GetPetTool } from "../../../src/credit/tools/get-pet.tool.js";',
    );

    expectStaticChecks(project, ["src", "tests"]);
    const tests = vitestOf(project);
    expect(tests.ok, tests.out).toBe(true);
    expect(tests.out).toContain("billing-check.test.ts");
    expect(tests.out).toContain("refund.tool.test.ts");
    expect(tests.out).toContain("get-pet.tool.test.ts");
    // the application's path is the example's package.json's (#268 AC1): no --application
    const described = agbossIn(project, ["describe"]);
    expect(described.ok, described.out).toBe(true);
    expect(described.out).toContain(
      "      route(OnboardingAssistantAgent)\n        .toFinish(TextWorkflowFinish),\n      route(BillingAgent)\n        .toFinish(TextWorkflowFinish)\n    )",
    );
    expect(described.out).toContain("· read-tickets-tool (MCP tickets)");
    expect(described.out).toContain("rag: policies-rag (tool, k 3)");
    expect(described.out).toContain("· get-pet-tool (local) ← PetsApiService");
    // #268 AC8: the new workflow is one more of the application, listed in @Application({ workflows })
    expect(described.out).toContain("onboarding-workflow 0.1.0");
    expect(text("src/flow-patterns.application.ts")).toMatch(
      /workflows: \[\n(?: {4}\w+,\n)+ {4}OnboardingWorkflow,\n {2}\]/,
    );
  }, 300_000);

  it("AC2: a rerun refuses; with --force it regenerates the files and doubles no wiring", async () => {
    const before = { workflow: text(module), router: text(router) };
    const again = await planGenerate(
      "agent",
      "billing-agent",
      { workflow, description: "Bills" },
      project,
    );

    await expect(applyChanges(project, again)).rejects.toThrow(
      `Already exists: src/agents/billing/billing.agent.ts, src/agents/billing/billing.prompt.md. Already wired: ${module}: BillingAgent already in OnboardingMainRouter's chooseOne(…); ${router}: BillingAgent already in routes. Nothing was written — rerun with --force to regenerate the files and keep the existing wiring`,
    );

    const forced = agbossIn(project, [
      "generate",
      "agent",
      "billing-agent",
      "--workflow",
      workflow,
      "--description",
      "Bills",
      "--force",
      "--json",
    ]);
    expect(forced.ok, forced.out).toBe(true);
    const envelope = JSON.parse(forced.stdout) as { warnings: string[]; modified: string[] };
    expect(envelope.warnings.slice(0, 2)).toEqual([
      `skipped: ${module}: BillingAgent already in OnboardingMainRouter's chooseOne(…)`,
      `skipped: ${router}: BillingAgent already in routes`,
    ]);
    // #237: the agent's own wiring (tools, MCP tool, knowledge base) is kept, not wiped
    expect(envelope.warnings.length).toBeGreaterThan(2);
    expect(
      envelope.warnings
        .slice(2)
        .every((w) => w.startsWith("kept: src/agents/billing/billing.agent.ts: ")),
    ).toBe(true);
    expect(text("src/agents/billing/billing.agent.ts")).toContain("RefundTool");
    expect(envelope.modified).toEqual([]);
    expect(text(module)).toBe(before.workflow);
    expect(text(router)).toBe(before.router);
    expect(text("src/agents/billing/billing.agent.ts")).toContain('description: "Bills"');
    for (const [kind, name, options] of AGENT_WIRING) {
      const plan = await planGenerate(kind, name, options, project);
      await applyChanges(project, plan, { force: true });
    }
    expect(text("src/agents/billing/billing.agent.ts").match(/RefundTool/g)).toHaveLength(2);
    expect(text(module).match(/TicketsServer/g)).toHaveLength(2);
    const tsc = agbossIn(project, ["describe"]);
    expect(tsc.ok, tsc.out).toBe(true);
  }, 120_000);
});
