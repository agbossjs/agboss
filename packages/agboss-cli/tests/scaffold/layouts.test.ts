/**
 * #197: every generator kind on the shipped example's layout (job-scout: one workflow at `src/`,
 * `ChatWorkflowFinish`, agents without the `Agent` suffix, tests in `tests/`), and reruns that never
 * double the wiring. The copy sits in `examples/` so the examples' lint rules apply to it.
 */
import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planGenerate, type GenerateOptions } from "../../src/scaffold/generate.js";
import { applyChanges } from "../../src/scaffold/write.js";
import { JOB_SCOUT_CHECK } from "../fixtures/job-scout-check.js";
import { expectStaticChecks, agbossIn, repo, vitestOf } from "./project-checks.js";

const example = join(repo, "examples/job-scout");
const project = join(repo, "examples", `.scaffold-tmp-job-scout-${String(process.pid)}`);
const workflow = "job-scout-workflow";
const module = "src/job-scout.workflow.ts";
const pets = new URL("../fixtures/openapi/pets.yaml", import.meta.url).pathname;
const text = (path: string): string => readFileSync(join(project, path), "utf8");

/** Each kind, as `agboss generate <kind> <full name> [options]` would plan it (#268 AC8). */
const KINDS: readonly (readonly [string, string, GenerateOptions])[] = [
  ["agent", "billing-agent", { workflow, description: "Handles invoices and refunds" }],
  ["tool", "refund-tool", { workflow, agent: "billing-agent" }],
  // a server the example's own tests really start: the filesystem server over its notes
  ["mcp", "tickets", { workflow, dir: join(project, "notes"), agent: "billing-agent" }],
  ["rag", "policies-rag", { workflow, folder: "policies", agent: "billing-agent" }],
  ["router", "escalation-router", { workflow }],
  ["openapi", "pets", { workflow, agent: "billing-agent", url: pets, operations: "getPet" }],
  ["workflow", "onboarding-workflow", {}],
];

/** The example's own tests that pin its shape (exact agents, routes, tools): adding parts changes it. */
const SHAPE_PINS = [
  "assembles from its components",
  "three agents, each answering on its own path",
  "the main router is Jev",
  // the recorded run replays the main router's request by hash: a new agent changes the router's
  // routes, so the request no longer matches the cassette — by design (#204), re-recorded per change
  "the recorded brief run replays",
];

beforeAll(() => {
  cpSync(example, project, {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  symlinkSync(join(example, "node_modules"), join(project, "node_modules"));
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("agboss generate on job-scout's layout", () => {
  it("AC1: every kind lands next to its kind, wired, and the example stays green", async () => {
    for (const [kind, name, options] of KINDS)
      await applyChanges(project, await planGenerate(kind, name, options, project));
    writeFileSync(join(project, "tests/billing-check.test.ts"), JOB_SCOUT_CHECK);

    // targets resolved from the workflow module: its agents folder, its router, its finish
    expect(existsSync(join(project, "src/agents/billing/billing.agent.ts"))).toBe(true);
    // #272: the router's choice in the flow gets the agent's path, its routes the agent
    expect(text(module)).toMatch(
      /route\(ShortlistAgent\)\n {10}\.toFinish\(ChatWorkflowFinish\),\n {8}route\(BillingAgent\)\n {10}\.toFinish\(ChatWorkflowFinish\),\n/,
    );
    // the new route goes after the last one, one per line
    expect(text("src/routers/main.router.ts")).toMatch(
      /target: ShortlistAgent },\n {4}\{ prompt: "Handles invoices and refunds", target: BillingAgent \},\n {2}\],/,
    );
    expect(text("src/routers/escalation/escalation.router.ts")).toContain(
      'import { ChatWorkflowFinish } from "../../workflow-finishes/chat.workflow-finish.js";',
    );
    // tests where vitest looks (tests/**), importing the tool where it is
    expect(existsSync(join(project, "src/tools/refund.tool.test.ts"))).toBe(false);
    expect(text("tests/refund.tool.test.ts")).toContain(
      'import { RefundTool } from "../src/tools/refund.tool.js";',
    );
    expect(text("tests/get-pet.tool.test.ts")).toContain(
      'import { GetPetTool } from "../src/tools/get-pet.tool.js";',
    );

    expectStaticChecks(project, ["src", "tests"]);
    const pins = SHAPE_PINS.join("|");
    const tests = vitestOf(project, ["--testNamePattern", `^(?!.*(${pins}))`]);
    expect(tests.ok, tests.out).toBe(true);
    expect(tests.out).toContain("billing-check.test.ts");
    expect(tests.out).toContain("refund.tool.test.ts");
    expect(tests.out).toContain("get-pet.tool.test.ts");
    // the application's path is the example's package.json's (#268 AC1): no --application
    const described = agbossIn(project, ["describe"]);
    expect(described.ok, described.out).toBe(true);
    expect(described.out).toContain(
      "      route(ShortlistAgent)\n        .toFinish(ChatWorkflowFinish),\n      route(BillingAgent)\n        .toFinish(ChatWorkflowFinish)\n    )",
    );
    expect(described.out).toContain("· read-tickets-tool (MCP tickets)");
    expect(described.out).toContain("rag: policies-rag (tool, k 3)");
    // #268 AC8: the new workflow is one more of the application, listed in @Application({ workflows })
    expect(described.out).toContain("onboarding-workflow 0.1.0");
    expect(text("src/job-scout.application.ts")).toMatch(
      /workflows: \[JobScout, OnboardingWorkflow\]/,
    );
  }, 300_000);

  it("AC2: a rerun refuses; with --force it regenerates the files and doubles no wiring", async () => {
    const before = { workflow: text(module), router: text("src/routers/main.router.ts") };
    const again = await planGenerate(
      "agent",
      "billing-agent",
      { workflow, description: "Bills" },
      project,
    );

    await expect(applyChanges(project, again)).rejects.toThrow(
      "Already exists: src/agents/billing/billing.agent.ts, src/agents/billing/billing.prompt.md. Already wired: src/job-scout.workflow.ts: BillingAgent already in MainRouter's chooseOne(…); src/routers/main.router.ts: BillingAgent already in routes. Nothing was written — rerun with --force to regenerate the files and keep the existing wiring",
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
      "skipped: src/job-scout.workflow.ts: BillingAgent already in MainRouter's chooseOne(…)",
      "skipped: src/routers/main.router.ts: BillingAgent already in routes",
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
    expect(text("src/routers/main.router.ts")).toBe(before.router);
    expect(text("src/agents/billing/billing.agent.ts")).toContain('description: "Bills"');
    for (const [kind, name, options] of KINDS.slice(1, 4)) {
      const plan = await planGenerate(kind, name, options, project);
      await applyChanges(project, plan, { force: true });
    }
    expect(text("src/agents/billing/billing.agent.ts").match(/RefundTool/g)).toHaveLength(2);
    expect(text(module).match(/TicketsServer/g)).toHaveLength(2);
    const tsc = agbossIn(project, ["describe"]);
    expect(tsc.ok, tsc.out).toBe(true);
  }, 120_000);
});
