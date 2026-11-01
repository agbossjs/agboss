import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Class } from "../components/index.js";
import { workflowInApplication } from "../application/workflow-application.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { AssembledWorkflow } from "../workflow.js";

import { applicationsNear } from "./application-files.js";
import { WorkflowLoadError } from "./load-errors.js";
import { registerTypeScript } from "./typescript.js";
import { lazyLoad } from "../infrastructure/clock.js";

export { WorkflowLoadError } from "./load-errors.js";

const isWorkflowClass = (value: unknown): value is Class =>
  typeof value === "function" && declarationOf(value as Class)?.kind === NodeKind.Workflow;

/** The one exported `@Workflow` class of a module file (`--workflow ./src/x.workflow.ts`). */
export async function loadWorkflowClass(
  path: string,
  options: { readonly typescript?: boolean } = {},
): Promise<Class> {
  const file = resolve(path);
  if (!existsSync(file)) throw new WorkflowLoadError(`Workflow file not found: ${file}`);
  if (options.typescript !== false) await registerTypeScript();
  const module = (await lazyLoad(import(pathToFileURL(file).href))) as Record<string, unknown>;
  const found = Object.values(module).filter(isWorkflowClass);
  const [workflow] = found;
  if (found.length !== 1 || workflow === undefined) {
    throw new WorkflowLoadError(
      `${file}: expected exactly one exported @Workflow class, found ${String(found.length)}`,
    );
  }
  return workflow;
}

/**
 * Loads and assembles the workflow of a module file — in its application when one loaded lists it
 * (its providers and `defaults`, #261).
 */
export const loadWorkflow = async (
  path: string,
  options: { readonly typescript?: boolean } = {},
): Promise<AssembledWorkflow> => {
  const workflow = await loadWorkflowClass(path, options);
  await applicationsNear(path, workflow);
  return workflowInApplication(workflow);
};
