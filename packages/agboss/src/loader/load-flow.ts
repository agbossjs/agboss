import { ConfigError } from "../core/error-families/config-errors.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationDeclarationOf } from "../application/application.js";
import type { Class } from "../components/injection.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { walkFlow } from "../flow/analyse/walk.js";
import type { LoadedModule } from "../flow/analyse/rules/context.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { toolComponentNameOf } from "../flow/types/agent-tools.js";
import { channelBrandOf } from "../flow/types/pause-target-tables.js";
import { judgeComponentNameOf } from "../flow/types/judge-outputs.js";
import { importedModules, registerTypeScript } from "./typescript.js";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * Loads the v2 workflows of module files (#272 S2) and the project modules they were loaded from:
 * every module tsx loaded (the import record), plus the workflow files and the files the components
 * were declared in — where TypeScript was compiled beforehand (tests), the record is empty and these
 * are the modules known.
 */

/** The v2 workflows of the loaded files and the project modules with their named exports. */
export interface FlowProject {
  readonly workflows: readonly Class[];
  /** The `@Application` classes the loaded modules export (#261: defaults, contexts). */
  readonly applications: readonly Class[];
  /**
   * The decorated classes the project's own modules export (#1324g): flow components, tools and
   * channels — the classes `.agboss/types.d.ts` brands, whether or not a workflow reaches them.
   */
  readonly components: readonly Class[];
  readonly modules: readonly LoadedModule[];
}

export interface FlowLoadOptions {
  /** false where TypeScript is already compiled (tests); tsx is registered by default. */
  readonly typescript?: boolean;
}

const isFlowWorkflow = (value: unknown): value is Class =>
  typeof value === "function" && declarationOf(value)?.kind === NodeKind.Workflow;

const isApplication = (value: unknown): value is Class =>
  typeof value === "function" && applicationDeclarationOf(value as Class) !== undefined;

const isComponent = (value: unknown): value is Class =>
  typeof value === "function" &&
  (declarationOf(value) !== undefined ||
    channelBrandOf(value as Class) !== undefined ||
    toolComponentNameOf(value as Class) !== undefined ||
    judgeComponentNameOf(value as Class) !== undefined);

const namespaceOf = async (file: string): Promise<Readonly<Record<string, unknown>>> =>
  (await lazyLoad(import(pathToFileURL(file).href))) as Readonly<Record<string, unknown>>;

/** The files the components of the workflows — their child workflows' too (#263) — were declared in. */
function componentFiles(workflows: readonly Class[]): readonly string[] {
  return withChildWorkflows(workflows).flatMap((workflow) => {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) return [];
    const { nodes } = walkFlow(declaration.options.flow, workflow).graph;
    return [...nodes.values()].flatMap((node) =>
      node.declaration.source === undefined ? [] : [node.declaration.source],
    );
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
    if (!existsSync(file))
      throw new ConfigError.WorkflowLoad({ message: `Workflow file not found: ${file}` });
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
  const components = [
    ...new Set(
      modules
        .filter((module) => own.has(module.file))
        .flatMap((module) => Object.values(module.exports).filter(isComponent)),
    ),
  ];
  return { workflows, applications, components, modules };
}
