import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDeclarationOf } from "../application/application.js";
import type { Class } from "../components/injection.js";

/**
 * The `@Application`s that list the workflow of a `--workflow <path>` file (#261 PR 2): exported by
 * the workflow's own module, else by a `*.application.ts` file of its folder or a folder above it,
 * up to the package (the folder with `package.json`). Importing them also makes the workflow's
 * application known to what works on one workflow (`loadWorkflow`, PR 4).
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

/** The exported applications listing `workflow`, from the first candidate file that has any. */
export async function applicationsNear(workflowPath: string, workflow: Class): Promise<Set<Class>> {
  const file = resolve(workflowPath);
  const candidates = [file, ...applicationFiles(dirname(file)).filter((other) => other !== file)];
  const found = new Set<Class>();
  for (const candidate of candidates) {
    for (const application of await applicationsIn(candidate, workflow)) found.add(application);
    if (found.size > 0) break;
  }
  return found;
}
