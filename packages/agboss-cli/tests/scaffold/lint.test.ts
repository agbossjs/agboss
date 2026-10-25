/**
 * #388: `agboss create` writes a working ESLint config — typescript-eslint and the AGBoss rules,
 * loaded from `agboss/eslint`. AC1: the new project passes its own `npm run lint`. AC2: a
 * component with `this.x = …` outside its constructor, direct time in it and a flow chain with two
 * calls on one line fail it, each with the rule named. Generated inside the monorepo (its installed
 * dependencies); a real `npm install` is the manual check.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { specFromFlags } from "../../src/scaffold/flags.js";
import type { WorkflowSpec } from "../../src/scaffold/plan.js";
import { planProject } from "../../src/scaffold/project.js";
import { applyChanges } from "../../src/scaffold/write.js";
import { agbossIn, lintOf } from "./project-checks.js";

const tmp = new URL("../../.scaffold-tmp", import.meta.url).pathname;
const project = join(tmp, `lint-app-${String(process.pid)}`);
const SERVICE = "src/services/api.service.ts";
const WORKFLOW = "src/workflows/lint-app/lint-app.workflow.ts";

const read = (path: string): string => readFileSync(join(project, path), "utf8");
const write = (path: string, content: string): void => {
  writeFileSync(join(project, path), content);
};

/** A method of the generated service that keeps state on `this` and reads the time directly. */
const STATEFUL_METHOD = `
  private lastCallAt = 0;

  /** Keeps state on the component and reads the clock of the machine. */
  touch(): number {
    this.lastCallAt = Date.now();
    return this.lastCallAt;
  }
`;

beforeAll(async () => {
  mkdirSync(tmp, { recursive: true });
  const spec = specFromFlags("lint-app", { yes: true }) as WorkflowSpec;
  await applyChanges(project, { create: planProject(spec), modify: [] });
  // the generated types the type-aware rules read (`npm install` runs it: postinstall)
  const checked = agbossIn(project, ["check"]);
  expect(checked.ok, checked.out).toBe(true);
}, 120_000);

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("#388: agboss create ships a working ESLint config", () => {
  it("AC1: the new project passes npm run lint, its script and dev dependencies in package.json", () => {
    const manifest = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    const lint = lintOf(project);

    expect(lint.ok, lint.out).toBe(true);
    expect(manifest.scripts.lint).toBe("eslint .");
    expect(manifest.scripts.check).toContain("npm run lint");
    expect(Object.keys(manifest.devDependencies)).toEqual(
      expect.arrayContaining([
        "eslint",
        "@eslint/js",
        "typescript-eslint",
        "@stylistic/eslint-plugin",
      ]),
    );
    expect(read("eslint.config.js")).toContain('from "agboss/eslint"');
  }, 60_000);

  it("AC2: state on a component, direct time and two chained calls on one line fail it, the rules named", () => {
    const service = read(SERVICE);
    const workflow = read(WORKFLOW);
    write(SERVICE, service.replace("  /** The full URL", `${STATEFUL_METHOD}\n  /** The full URL`));
    write(
      WORKFLOW,
      workflow.replace(
        /route\(LintAppAssistantAgent\)\s+\.toFinish\(TextWorkflowFinish\)/,
        "route(LintAppAssistantAgent).toFinish(TextWorkflowFinish)",
      ),
    );

    const lint = lintOf(project);
    write(SERVICE, service);
    write(WORKFLOW, workflow);

    expect(lint.ok).toBe(false);
    expect(lint.out).toMatch(
      /`this\.lastCallAt = …` outside the constructor .*agboss\/no-component-state/,
    );
    expect(lint.out).toMatch(/`Date\.now` reads the time directly: .*agboss\/no-direct-time/);
    expect(lint.out).toMatch(
      /lint-app\.workflow\.ts\n\s+\d+:\d+\s+error\s+Expected line break before `\.toFinish`\s+@stylistic\/newline-per-chained-call/,
    );
    expect(lintOf(project).ok).toBe(true);
  }, 60_000);

  it("direct time is allowed in the project's tests, which move the test clock instead", () => {
    const path = "tests/workflows/lint-app/time.test.ts";
    write(
      path,
      'import { expect, it } from "vitest";\n\nit("reads the time", () => {\n  expect(Date.now()).toBeGreaterThan(0);\n});\n',
    );

    const lint = lintOf(project);
    rmSync(join(project, path));

    expect(lint.ok, lint.out).toBe(true);
  }, 60_000);
});
