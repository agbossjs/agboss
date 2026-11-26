/**
 * #239, #261, #1324b: `agboss create` puts the project's `defineEnv` in `src/config/app.env.ts` and its
 * `test` profile in `src/config/`, next to the application file, and reads the values through
 * `deps: [appEnv]` for real (the tools' `ApiService`); `agboss check` and the tests run on them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { specFromFlags } from "../../src/scaffold/flags.js";
import type { WorkflowSpec } from "../../src/scaffold/plan.js";
import { planProject } from "../../src/scaffold/project.js";
import { applyChanges } from "../../src/scaffold/write.js";
import { expectStaticChecks, agbossIn, vitestOf } from "./project-checks.js";
import { CHECKS_RUN, ledgerWarning } from "../cli/agboss.js";

const tmp = new URL("../../.scaffold-tmp", import.meta.url).pathname;
const project = join(tmp, `shop-${String(process.pid)}`);
/** The project's application: `"agboss": { "application" }` of its package.json (#268). */
const application = "src/shop.application.ts";
const read = (path: string): string => readFileSync(join(project, path), "utf8");

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("#239: the environment and the test profile, read through deps: [appEnv] for real", () => {
  it("AC1: a fresh project — its ApiService (deps: [appEnv]) starts with the app and its test passes", async () => {
    mkdirSync(tmp, { recursive: true });
    const spec = specFromFlags("shop", {
      yes: true,
      agents: "clerk-agent:Answers about orders",
      tools: "clerk-agent:find-order-tool",
    }) as WorkflowSpec;
    await applyChanges(project, { create: planProject(spec), modify: [] });

    for (const file of ["src/config/app.env.ts", "src/config/test.config.ts"])
      expect(existsSync(join(project, file)), file).toBe(true);
    expect(existsSync(join(project, "src/environments"))).toBe(false);
    expect(read("src/services/api.service.ts")).toContain("@Injectable({ deps: [appEnv] })");
    expect(read("src/shop.application.ts")).not.toContain("environment:");
    // #891: the service's test runs on the application as testWith builds it, on its test profile
    expect(read("tests/services/api.service.test.ts")).toContain("testWith(ShopApplication)");
    expect(read("src/tools/find-order.tool.ts")).toContain("deps: [ExecutionContext, ApiService]");
    expectStaticChecks(project, ["src"]);
    const tests = vitestOf(project);
    expect(tests.ok, tests.out).toBe(true);
    expect(tests.out).toContain("api.service.test.ts");
    expect(tests.out).toContain("shop.workflow.test.ts");
    const check = agbossIn(project, ["check"]);
    // the report (#268 AC5) between the types and the warnings: the application, each start's worst case
    expect(check.out).toMatch(
      /^types: \.agboss\/types\.d\.ts\nshop-application 0\.1\.0, profiles dev\n\nWorst case of one [a-z-]+-workflow-start call\n/,
    );
    expect(
      check.out.endsWith(`\n\n${ledgerWarning(application)}ok: ${application} — ${CHECKS_RUN}\n`),
    ).toBe(true);
    const described = agbossIn(project, ["describe"]);
    expect(described.out).toContain(
      "· find-order-tool (local) ← ExecutionContext, ApiService (defineEnv({ apiUrl }))",
    );
  }, 240_000);
});
