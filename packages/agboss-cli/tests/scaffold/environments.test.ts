/**
 * #239, #261: `agboss create` puts the environments where the runtime looks — next to the
 * application file, its contract declared in `@Application({ environment })` — and reads it through `ApplicationContext` for
 * real (the tools' `ApiService`); `agboss check` fails exactly when the start would.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { specFromFlags } from "../../src/scaffold/flags.js";
import type { WorkflowSpec } from "../../src/scaffold/plan.js";
import { planProject } from "../../src/scaffold/project.js";
import { applyChanges } from "../../src/scaffold/write.js";
import { expectStaticChecks, agbossIn, vitestOf } from "./project-checks.js";
import { CHECKS_RUN, ledgerWarning, piiKeyWarning } from "../cli/agboss.js";

const tmp = new URL("../../.scaffold-tmp", import.meta.url).pathname;
const project = join(tmp, `shop-${String(process.pid)}`);
/** The project's application: `"agboss": { "application" }` of its package.json (#268). */
const application = "src/shop.application.ts";
const environments = join(project, "src/environments");
const read = (path: string): string => readFileSync(join(project, path), "utf8");
const MISSING =
  /^Environment "dev" not found: .*environments\/dev\.environment\.ts\. Available: none/;

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("#239: environments next to the workflow file, read through ApplicationContext for real", () => {
  it("AC1: a fresh project — its ApiService (deps: [ApplicationContext]) starts with the app and its test passes", async () => {
    mkdirSync(tmp, { recursive: true });
    const spec = specFromFlags("shop", {
      yes: true,
      agents: "clerk-agent:Answers about orders",
      tools: "clerk-agent:find-order-tool",
    }) as WorkflowSpec;
    await applyChanges(project, { create: planProject(spec), modify: [] });

    for (const file of [
      "app.environment.ts",
      "dev.environment.ts",
      "staging.environment.ts",
      "test.environment.ts",
    ])
      expect(existsSync(join(environments, file)), file).toBe(true);
    expect(existsSync(join(project, "src/shop/environments"))).toBe(false);
    expect(read("src/services/api.service.ts")).toContain(
      "@Injectable({ deps: [ApplicationContext] })",
    );
    expect(read("src/shop.application.ts")).toContain("  environment: AppEnvironment,\n");
    expect(read("src/tools/find-order.tool.ts")).toContain("deps: [ExecutionContext, ApiService]");
    expectStaticChecks(project, ["src"]);
    const tests = vitestOf(project);
    expect(tests.ok, tests.out).toBe(true);
    expect(tests.out).toContain("api.service.test.ts");
    expect(tests.out).toContain("shop.workflow.test.ts");
    const check = agbossIn(project, ["check"]);
    // the report (#268 AC5) between the types and the warnings: the application, each start's worst case
    expect(check.out).toMatch(
      /^types: \.agboss\/types\.d\.ts\nshop-application 0\.1\.0, environment dev\n\nWorst case of one [a-z-]+-workflow-start call\n/,
    );
    expect(
      check.out.endsWith(
        `\n\n${ledgerWarning(application)}${piiKeyWarning(application)}ok: ${application} — ${CHECKS_RUN}\n`,
      ),
    ).toBe(true);
    const described = agbossIn(project, ["describe"]);
    expect(described.out).toContain("environment dev");
    expect(described.out).toContain('apiUrl = "https://api.example.com"');
    expect(described.out).toContain(
      "· find-order-tool (local) ← ExecutionContext, ApiService (ApplicationContext)",
    );
  }, 240_000);

  it("AC2: the environment files moved away → agboss check fails with environment.not-found, as the app's start", () => {
    const files = ["dev", "staging", "test"].map((name) =>
      join(environments, `${name}.environment.ts`),
    );
    for (const file of files) renameSync(file, `${file}.moved`);
    try {
      const check = agbossIn(project, ["check", "--json"]);
      expect(check.status, check.out).toBe(3);
      const { result } = JSON.parse(check.stdout) as {
        result: { problems: { code: string; message: string }[] };
      };
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]?.code).toBe("environment.not-found");
      expect(result.problems[0]?.message).toMatch(MISSING);
      // the app's start (testWith builds the app as createApp does) fails the same way
      const tests = vitestOf(project, ["--project", "unit"]);
      expect(tests.ok).toBe(false);
      expect(tests.out).toContain('Environment "test" not found');
    } finally {
      for (const file of files) renameSync(`${file}.moved`, file);
    }
    expect(agbossIn(project, ["check"]).ok).toBe(true);
  }, 120_000);
});
