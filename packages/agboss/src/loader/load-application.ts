import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDeclarationOf } from "../application/application.js";
import type { Class } from "../components/injection.js";
import { loadWorkflowClass } from "./load-workflow.js";
import { WorkflowLoadError } from "./load-errors.js";
import { registerTypeScript } from "./typescript.js";

/**
 * Which `@Application` runs the workflow of a `--workflow <path>` file (#261 PR 2) — the CLI's
 * bridge until #268 reads the application's path from `package.json`: the one exported
 * `@Application` that lists the workflow, in the workflow's own module or in a `*.application.ts`
 * file of its folder or a folder above it, up to the package (the folder with `package.json`).
 */

const APPLICATION_FILE = /\.application\.(ts|mts|js|mjs)$/;

/** The `*.application.ts` files of a folder and of every folder above it, up to the package. */
function applicationFiles(from: string): string[] {
  const files: string[] = [];
  for (let dir = from; ; dir = dirname(dir)) {
    const names = readdirSync(dir).filter((name) => APPLICATION_FILE.test(name));
    files.push(...names.sort().map((name) => join(dir, name)));
    if (existsSync(join(dir, "package.json")) || dirname(dir) === dir) return files;
  }
}

const isApplicationOf = (value: unknown, workflow: Class): value is Class =>
  typeof value === "function" &&
  (applicationDeclarationOf(value as Class)?.options.workflows.includes(workflow) ?? false);

/** The exported applications of a module that list `workflow`. */
async function applicationsIn(file: string, workflow: Class): Promise<Class[]> {
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  return Object.values(module).filter((value) => isApplicationOf(value, workflow));
}

export async function loadApplicationClass(
  workflowPath: string,
  options: { readonly typescript?: boolean } = {},
): Promise<Class> {
  const workflow = await loadWorkflowClass(workflowPath, options);
  if (options.typescript !== false) await registerTypeScript();
  const file = resolve(workflowPath);
  const candidates = [file, ...applicationFiles(dirname(file)).filter((other) => other !== file)];
  const found = new Set<Class>();
  for (const candidate of candidates) {
    for (const application of await applicationsIn(candidate, workflow)) found.add(application);
    if (found.size > 0) break;
  }
  const [application] = found;
  if (found.size === 1 && application !== undefined) return application;
  const names = [...found].map((cls) => cls.name).join(", ");
  throw new WorkflowLoadError(
    found.size === 0
      ? `${file}: no exported @Application lists ${workflow.name} — add one in a *.application.ts file next to it: @Application({ name, version, workflows: [${workflow.name}] })`
      : `${file}: ${names} all list ${workflow.name} — keep one application per workflow file`,
  );
}
