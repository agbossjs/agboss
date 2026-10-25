/**
 * #268 AC8: `agboss generate` takes full names only — the part's (`billing-agent`) and the
 * workflow's (`--workflow desk-workflow`, found in the application) — and never adds a suffix;
 * `generate workflow` writes the workflow and lists it in `@Application({ workflows })`.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScaffoldConflictError, ScaffoldUsageError } from "../../src/scaffold/errors.js";
import { planGenerate } from "../../src/scaffold/generate.js";
import { workflowDeclaration, writeApplication } from "./application-fixture.js";

const DESK = { module: "src/desk/desk.workflow.ts", className: "Desk", name: "desk-workflow" };
const ONBOARDING = {
  module: "src/onboarding/onboarding.workflow.ts",
  className: "Onboarding",
  name: "onboarding-workflow",
};

/** A project whose application lists the desk workflow, which launches the onboarding one. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-generate-"));
  writeApplication(root, DESK);
  mkdirSync(join(root, "src/desk"), { recursive: true });
  mkdirSync(join(root, "src/onboarding"), { recursive: true });
  writeFileSync(
    join(root, DESK.module),
    `import { Onboarding } from "../onboarding/onboarding.workflow.js";\n${workflowDeclaration(DESK)}`,
  );
  writeFileSync(join(root, ONBOARDING.module), workflowDeclaration(ONBOARDING));
  return root;
}

describe("#268 AC8: generators take full names", () => {
  it("a name without its kind suffix is rejected with the full name as a hint; nothing is planned", async () => {
    const root = project();

    await expect(
      planGenerate("agent", "ranker", { workflow: "desk-workflow" }, root),
    ).rejects.toThrow(
      new ScaffoldUsageError(
        '"ranker" is not a full agent name: kebab-case, ending with -agent. Did you mean "ranker-agent"?',
      ),
    );
    await expect(planGenerate("workflow", "checkout", {}, root)).rejects.toThrow(
      'Did you mean "checkout-workflow"?',
    );
    await expect(
      planGenerate("tool", "refund_card", { workflow: "desk-workflow" }, root),
    ).rejects.toThrow('Did you mean "refund-card-tool"?');
  });

  it("--workflow names a workflow of the application by its full name — its children too", async () => {
    const root = project();

    await expect(
      planGenerate("router", "escalation-router", { workflow: "desk" }, root),
    ).rejects.toThrow(
      new ScaffoldUsageError(
        'Workflow "desk" not found in src/desk.application.ts. Did you mean "desk-workflow"? Workflows: desk-workflow, onboarding-workflow',
      ),
    );
    await expect(planGenerate("router", "escalation-router", {}, root)).rejects.toThrow(
      "--workflow <full name> is required — one of: desk-workflow, onboarding-workflow",
    );
    // the child is found through its parent's imports: its module, whatever its folder
    await expect(
      planGenerate("router", "escalation-router", { workflow: "onboarding-workflow" }, root),
    ).rejects.toThrow("src/onboarding/onboarding.workflow.ts: imports no @WorkflowFinish class");
  });

  it("no application in package.json or --application → where to set it", async () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-generate-"));
    writeFileSync(join(root, "package.json"), "{}");

    await expect(
      planGenerate("agent", "billing-agent", { workflow: "desk-workflow" }, root),
    ).rejects.toThrow(
      'No application: set "agboss": { "application": "src/<name>.application.ts" } in package.json, or pass --application <path>',
    );
  });

  it("generate workflow: its files beside the application's, listed in @Application({ workflows }), run scripts by its start", async () => {
    const root = project();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ agboss: { application: "src/desk.application.ts" }, scripts: {} }),
    );

    const { create, modify } = await planGenerate("workflow", "checkout-workflow", {}, root);

    const paths = create.map((file) => file.path);
    expect(paths).toContain("src/checkout/checkout.workflow.ts");
    expect(paths).toContain("src/checkout/checkout.workflow.test.ts");
    expect(paths).toContain("src/checkout/agents/checkout-assistant/checkout-assistant.agent.ts");
    expect(paths.some((path) => path.endsWith(".application.ts"))).toBe(false);
    const module = create.find((file) => file.path === "src/checkout/checkout.workflow.ts");
    expect(module?.content).toContain('name: "checkout-workflow",');
    const test = create.find((file) => file.path === "src/checkout/checkout.workflow.test.ts");
    expect(test?.content).toContain('import { DeskApplication } from "../desk.application.js";');
    const [application, packageJson] = modify;
    expect(application?.path).toBe("src/desk.application.ts");
    expect(application?.content).toContain("workflows: [Desk, CheckoutWorkflow],");
    expect(application?.content).toContain(
      'import { CheckoutWorkflow } from "./checkout/checkout.workflow.js";',
    );
    expect(JSON.parse(packageJson?.content ?? "{}")).toMatchObject({
      scripts: {
        "chat:checkout": "agboss chat --start checkout-text-workflow-start",
        "run:checkout": "agboss run --start checkout-text-workflow-start",
      },
    });
  });

  it("generate workflow of a name the application has → a conflict, nothing written", async () => {
    const root = project();

    await expect(planGenerate("workflow", "onboarding-workflow", {}, root)).rejects.toThrow(
      new ScaffoldConflictError(
        "src/desk.application.ts: the application already has onboarding-workflow",
      ),
    );
  });

  it("single-letter and short kind aliases resolve to their canonical kind", async () => {
    const root = project();

    await expect(planGenerate("w", "onboarding-workflow", {}, root)).rejects.toThrow(
      new ScaffoldConflictError(
        "src/desk.application.ts: the application already has onboarding-workflow",
      ),
    );
    await expect(planGenerate("a", "ranker", { workflow: "desk-workflow" }, root)).rejects.toThrow(
      'Did you mean "ranker-agent"?',
    );
    await expect(
      planGenerate("t", "refund_card", { workflow: "desk-workflow" }, root),
    ).rejects.toThrow('Did you mean "refund-card-tool"?');
    await expect(
      planGenerate("r", "escalation", { workflow: "desk-workflow" }, root),
    ).rejects.toThrow('Did you mean "escalation-router"?');
    await expect(planGenerate("ar", "pick", { workflow: "desk-workflow" }, root)).rejects.toThrow(
      'Did you mean "pick-arbiter"?',
    );
  });
});
