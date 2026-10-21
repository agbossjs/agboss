import { readFileSync } from "node:fs";
import { ScaffoldUsageError } from "./errors.js";
import { namesOf, type Names } from "./names.js";
import { planWorkflow, render, vars, workflowDir, type WorkflowSpec } from "./plan.js";
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

/** Where a workflow's application is: `src/<name>/<name>.application.ts` (#261, until #268 PR 4). */
export const applicationPathOf = (workflow: Names): string =>
  `${workflowDir(workflow)}/${workflow.kebab}.application.ts`;

/**
 * The npm scripts of one application (#268): the project's first needs no path — its application is
 * `"agboss": { "application" }` of package.json — every later one (a suffix `:name`) names its own
 * with `--application` until `generate workflow` wires workflows into one application (#268 PR 4).
 */
export function workflowScripts(workflow: Names, suffix = ""): Record<string, string> {
  const application = suffix === "" ? "" : ` --application ${applicationPathOf(workflow)}`;
  const commands: Readonly<Record<string, string>> = {
    chat: "chat",
    run: "run",
    describe: "describe",
    "rag:index": "rag index",
  };
  return {
    ...Object.fromEntries(
      Object.entries(commands).map(([script, command]) => [
        `${script}${suffix}`,
        `agboss ${command}${application}`,
      ]),
    ),
    // writes .agboss/types.d.ts: the generated types the flow compiles against (#272) — no model
    // key needed: without --models the check reads the environment's shape, not its secrets (#266)
    [`types${suffix}`]: `agboss check${application}`,
  };
}

/** The first workflow's test on `agboss/testing`: its first agent, by script. */
function workflowTest(spec: WorkflowSpec): FileToWrite {
  const workflow = namesOf(spec.name);
  const [first] = spec.agents;
  if (first === undefined) throw new ScaffoldUsageError("A workflow needs at least one agent");
  const agent = namesOf(first.name);
  return {
    path: `${workflowDir(workflow)}/${workflow.kebab}.workflow.test.ts`,
    content: render("project/workflow.test.ts.tmpl", {
      ...vars(workflow),
      agent: agent.pascal,
      agentKebab: agent.kebab,
    }),
  };
}

/**
 * The environments next to the application file, where the app looks for them (#239, #261): the
 * contract, dev, staging and test (tests run on it); and the service that reads it through
 * `ApplicationContext` — the
 * project's tools use it — with its test.
 */
function environmentFiles(spec: WorkflowSpec): FileToWrite[] {
  const workflow = namesOf(spec.name);
  const dir = workflowDir(workflow);
  const file = (path: string, template: string): FileToWrite => ({
    path: `${dir}/${path}`,
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

/** `agboss create`: a standalone project with its first workflow and its test. */
export function planProject(spec: WorkflowSpec): FileToWrite[] {
  const project = namesOf(spec.name);
  const scripts = Object.entries(workflowScripts(project))
    .map(([k, v]) => `    "${k}": "${v}",`)
    .join("\n");
  const dependencies = {
    agboss: `^${cli.dependencies.agboss ?? cli.version}`,
    zod: cli.dependencies.zod ?? "latest",
    ...(spec.mcp.kind === "filesystem"
      ? { [FILESYSTEM_SERVER_PACKAGE]: filesystemServerVersion() }
      : {}),
  };
  const variables = {
    kebab: project.kebab,
    title: project.title,
    application: applicationPathOf(project),
    scripts,
    dependencies: Object.entries(dependencies)
      .map(([k, v]) => `    "${k}": "${v}"`)
      .join(",\n"),
    cliVersion: `^${cli.version}`,
    typescriptVersion: cli.dependencies.typescript ?? "latest",
  };
  return [
    { path: "package.json", content: render("project/package.json.tmpl", variables) },
    { path: "tsconfig.json", content: render("project/tsconfig.json.tmpl", {}) },
    { path: "vitest.config.ts", content: render("project/vitest.config.ts.tmpl", {}) },
    { path: ".env.example", content: render("project/env.example.tmpl", {}) },
    { path: ".gitignore", content: render("project/gitignore.tmpl", {}) },
    { path: "README.md", content: render("project/README.md.tmpl", variables) },
    ...environmentFiles(spec),
    ...planWorkflow(spec, true),
    workflowTest(spec),
  ];
}
