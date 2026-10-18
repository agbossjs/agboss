import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDeclarationOf } from "../application/application.js";
import type { Class } from "../components/injection.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { walkFlow } from "../flow/analyse/walk.js";
import type { LoadedModule } from "../flow/analyse/rules/context.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { WorkflowLoadError } from "./load-errors.js";
import { importedModules, registerTypeScript } from "./typescript.js";

/**
 * Loads the v2 workflows of module files (#272 S2) and the project modules they were loaded from:
 * every module tsx loaded (the import record), plus the workflow files and the files the components
 * were declared in — where TypeScript was compiled beforehand (tests), the record is empty and these
 * are the modules known.
 */

/** The v2 workflows of the loaded files and the project modules with their named exports. */
export interface FlowProject {
  readonly workflows: readonly Class[];
  /** The `@Application` classes the loaded modules export (#261: defaults, environment contract). */
  readonly applications: readonly Class[];
  readonly modules: readonly LoadedModule[];
}

export interface FlowLoadOptions {
  /** false where TypeScript is already compiled (tests); tsx is registered by default. */
  readonly typescript?: boolean;
}

const isFlowWorkflow = (value: unknown): value is Class =>
  typeof value === "function" && declarationOf(value as Class)?.kind === NodeKind.Workflow;

const isApplication = (value: unknown): value is Class =>
  typeof value === "function" && applicationDeclarationOf(value as Class) !== undefined;

const namespaceOf = async (file: string): Promise<Readonly<Record<string, unknown>>> =>
  (await import(pathToFileURL(file).href)) as Readonly<Record<string, unknown>>;

/** The files the components of the workflows — their child workflows' too (#263) — were declared in. */
function componentFiles(workflows: readonly Class[]): readonly string[] {
  return withChildWorkflows(workflows).flatMap((workflow) => {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) return [];
    const { nodes } = walkFlow(declaration.options.flow).graph;
    return [...nodes.values()].flatMap((node) =>
      node.declaration.source === undefined ? [] : [node.declaration.source],
    );
  });
}

/**
 * The files of each application's `environments/` folder (#261): its contract is imported from
 * there by the generated types, whether or not tsx recorded the import.
 */
function environmentFilesOf(applications: readonly Class[]): string[] {
  return applications.flatMap((application) => {
    const source = applicationDeclarationOf(application)?.source;
    if (source === undefined) return [];
    const dir = join(dirname(source), "environments");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => /\.environment\.(ts|mts|js|mjs)$/.test(file) && !file.endsWith(".d.ts"))
      .sort()
      .map((file) => join(dir, file));
  });
}

export async function loadFlowProject(
  paths: readonly string[],
  options: FlowLoadOptions = {},
): Promise<FlowProject> {
  if (options.typescript !== false) await registerTypeScript();
  const files = paths.map((path) => resolve(path));
  const workflows: Class[] = [];
  for (const file of files) {
    if (!existsSync(file)) throw new WorkflowLoadError(`Workflow file not found: ${file}`);
    workflows.push(...Object.values(await namespaceOf(file)).filter(isFlowWorkflow));
  }
  const own = new Set([...files, ...componentFiles(workflows)]);
  const known = new Set([...importedModules(), ...own]);
  const modules: LoadedModule[] = [];
  for (const file of [...known].sort()) {
    const exports = await namespaceOf(file).catch((error: unknown) => {
      // a module loaded earlier in the process that failed then is not one of these workflows'
      if (own.has(file)) throw error;
      return undefined;
    });
    if (exports !== undefined) modules.push({ file, exports });
  }
  const applications = [
    ...new Set(modules.flatMap((module) => Object.values(module.exports).filter(isApplication))),
  ];
  const loaded = new Set(modules.map((module) => module.file));
  for (const file of environmentFilesOf(applications).filter((path) => !loaded.has(path)))
    modules.push({ file, exports: await namespaceOf(file) });
  return { workflows, applications, modules };
}
