import { readFileSync } from "node:fs";
import { applicationFiles, applicationPathOf } from "./application-files.js";
import { fullNameOf, namesOf, type Names } from "./names.js";
import { render, type WorkflowSpec } from "./plan.js";
import { codingAgentFiles } from "./skills-files.js";
import { planWorkflow } from "./workflow-files.js";
import type { FileToWrite } from "./write.js";

interface PackageJson {
  readonly version: string;
  readonly dependencies: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/**
 * This CLI's own package.json: the versions a generated project depends on — `agboss` (the
 * exact version the CLI is built on), the CLI itself for the `agboss` scripts, zod and TypeScript.
 */
const cli = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageJson;

export const FILESYSTEM_SERVER_PACKAGE = "@modelcontextprotocol/server-filesystem";
export const filesystemServerVersion = (): string =>
  cli.devDependencies?.[FILESYSTEM_SERVER_PACKAGE] ?? "latest";

/** The text start of a workflow, by its full name: `desk-text-workflow-start` (#268 AC2). */
export const textStartOf = (workflow: Names): string => `${workflow.kebab}-text-workflow-start`;

/**
 * The scripts that run one workflow of the application (#268 AC2): by its start's full name, so
 * they keep working when the application gets more workflows — `chat` / `run` for the project's
 * first, `chat:<name>` / `run:<name>` for each one `generate workflow` adds.
 */
export function workflowScripts(workflow: Names, suffix = ""): Record<string, string> {
  const start = `--start ${textStartOf(workflow)}`;
  return { [`chat${suffix}`]: `agboss chat ${start}`, [`run${suffix}`]: `agboss run ${start}` };
}

/** The scripts of the whole application: its application path comes from package.json (#268 AC1). */
const APPLICATION_SCRIPTS: Readonly<Record<string, string>> = {
  describe: "agboss describe",
  "rag:index": "agboss rag index",
  // writes .agboss/types.d.ts: the generated types the flow compiles against (#272) — no model
  // key needed: without --models the check reads the environment's shape, not its secrets (#266)
  types: "agboss check",
};

/**
 * The environments next to the application file, where the app looks for them (#239, #261): the
 * contract, dev, staging and test (tests run on it); and the service that reads it through
 * `ApplicationContext` — the project's tools use it — with its test.
 */
function environmentFiles(): FileToWrite[] {
  const file = (path: string, template: string): FileToWrite => ({
    path: `src/${path}`,
    content: render(`project/${template}.tmpl`, {}),
  });
  return [
    file("environments/app.environment.ts", "app.environment.ts"),
    file("environments/dev.environment.ts", "dev.environment.ts"),
    file("environments/staging.environment.ts", "staging.environment.ts"),
    file("environments/test.environment.ts", "test.environment.ts"),
    file("services/api.service.ts", "api.service.ts"),
    file("services/api.service.test.ts", "api.service.test.ts"),
  ];
}

const jsonLines = (entries: Readonly<Record<string, string>>, indent: string): string[] =>
  Object.entries(entries).map(([k, v]) => `${indent}"${k}": "${v}"`);

/** The project's package.json: its application's path, its scripts, its dependencies. */
function packageJsonOf(spec: WorkflowSpec, project: Names, workflow: Names): FileToWrite {
  const scripts = { ...workflowScripts(workflow), ...APPLICATION_SCRIPTS };
  const dependencies = {
    agboss: `^${cli.dependencies.agboss ?? cli.version}`,
    zod: cli.dependencies.zod ?? "latest",
    ...(spec.mcp.kind === "filesystem"
      ? { [FILESYSTEM_SERVER_PACKAGE]: filesystemServerVersion() }
      : {}),
  };
  const variables = {
    kebab: project.kebab,
    application: applicationPathOf(project),
    scripts: jsonLines(scripts, "    ").join(",\n") + ",",
    dependencies: jsonLines(dependencies, "    ").join(",\n"),
    cliVersion: `^${cli.version}`,
    typescriptVersion: cli.dependencies.typescript ?? "latest",
  };
  return { path: "package.json", content: render("project/package.json.tmpl", variables) };
}

/**
 * `agboss create <project>` (#268 AC8): a standalone project — its application
 * (`src/<project>.application.ts`, its path in package.json), the application's environments,
 * budgets, model provider and guardrail, and its first workflow `<project>-workflow` in
 * `src/<project>/`, with its tests.
 */
export function planProject(spec: WorkflowSpec): FileToWrite[] {
  const workflow = fullNameOf(spec.name, "workflow");
  const project = namesOf(workflow.kebab);
  const variables = { kebab: project.kebab, title: project.title };
  return [
    packageJsonOf(spec, project, workflow),
    { path: "tsconfig.json", content: render("project/tsconfig.json.tmpl", {}) },
    { path: "vitest.config.ts", content: render("project/vitest.config.ts.tmpl", {}) },
    // `npm run lint` (#388): typescript-eslint and the AGBoss rules (`agboss/eslint`)
    { path: "eslint.config.js", content: render("project/eslint.config.js.tmpl", {}) },
    { path: ".env.example", content: render("project/env.example.tmpl", {}) },
    { path: ".gitignore", content: render("project/gitignore.tmpl", {}) },
    { path: "README.md", content: render("project/README.md.tmpl", variables) },
    ...codingAgentFiles(project),
    ...environmentFiles(),
    ...applicationFiles(project),
    ...planWorkflow(spec, {
      dir: `src/${project.kebab}`,
      application: { className: `${project.pascal}Application`, path: applicationPathOf(project) },
      service: "src/services/api.service.ts",
    }),
  ];
}
