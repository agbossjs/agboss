import { resolve } from "node:path";
import type { Class } from "../components/injection.js";
import { environmentOwnerOfWorkflow } from "../application/workflow-application.js";
import type { EnvironmentOwner } from "../environments/load.js";
import { applicationsNear } from "./application-files.js";
import { loadWorkflowClass } from "./load-workflow.js";
import { WorkflowLoadError } from "./load-errors.js";
import { registerTypeScript } from "./typescript.js";

/**
 * Which `@Application` runs the workflow of a `--workflow <path>` file (#261 PR 2) — the CLI's
 * bridge until #268 reads the application's path from `package.json`: the one exported
 * `@Application` that lists the workflow, in the workflow's own module or in a `*.application.ts`
 * file of its folder or a folder above it, up to the package (the folder with `package.json`).
 */

export async function loadApplicationClass(
  workflowPath: string,
  options: { readonly typescript?: boolean } = {},
): Promise<Class> {
  const workflow = await loadWorkflowClass(workflowPath, options);
  if (options.typescript !== false) await registerTypeScript();
  const file = resolve(workflowPath);
  const found = await applicationsNear(file, workflow);
  const [application] = found;
  if (found.size === 1 && application !== undefined) return application;
  const names = [...found].map((cls) => cls.name).join(", ");
  throw new WorkflowLoadError(
    found.size === 0
      ? `${file}: no exported @Application lists ${workflow.name} — add one in a *.application.ts file next to it: @Application({ name, version, workflows: [${workflow.name}] })`
      : `${file}: ${names} all list ${workflow.name} — keep one application per workflow file`,
  );
}

/**
 * Where the environments of the application that lists the workflow of a `--workflow <path>` file
 * are (#261): its file and contract; a workflow no single application lists has none.
 */
export async function environmentOwnerOfFile(
  workflowPath: string,
  options: { readonly typescript?: boolean } = {},
): Promise<EnvironmentOwner> {
  const workflow = await loadWorkflowClass(workflowPath, options);
  await applicationsNear(workflowPath, workflow);
  return environmentOwnerOfWorkflow(workflow);
}
