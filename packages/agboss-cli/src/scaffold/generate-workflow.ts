import { dirname } from "node:path/posix";
import { applicationGraph } from "./application-graph.js";
import { ScaffoldConflictError } from "./errors.js";
import { defaultAgentOf } from "./flags.js";
import type { GenerateOptions } from "./generate.js";
import { withScripts } from "./generate-parts.js";
import { fullNameOf } from "./names.js";
import { workflowScripts } from "./project.js";
import { wire } from "./wire.js";
import { planWorkflow } from "./workflow-files.js";
import { importPath } from "./workflow-graph.js";
import type { Changes } from "./write.js";

/**
 * `agboss generate workflow <name>-workflow` (#268 AC8): a new workflow of the application — its
 * files in `<application folder>/<name>/`, its class listed in `@Application({ workflows })`, its
 * `chat:<name>` / `run:<name>` scripts by its start's full name. A workflow of that name already
 * in the application is a conflict; nothing is written.
 */
export function planNewWorkflow(root: string, name: string, o: GenerateOptions): Changes {
  const workflow = fullNameOf(name, "workflow");
  const application = applicationGraph(root, o.application);
  if (application.workflows.some((known) => known.name === workflow.full))
    throw new ScaffoldConflictError(
      `${application.module.path}: the application already has ${workflow.full}`,
    );
  const srcDir = dirname(application.module.path);
  const dir = `${srcDir}/workflows/${workflow.kebab}`;
  const routerName = application.workflows.length === 0 ? "main" : `${workflow.kebab} main`;
  const spec = {
    name: workflow.full,
    agents: [defaultAgentOf(workflow)],
    mcp: { kind: "none" },
  } as const;
  const module = `${dir}/${workflow.kebab}.workflow.ts`;
  const className = `${workflow.pascal}Workflow`;
  return {
    create: planWorkflow(spec, {
      dir,
      srcDir,
      routerName,
      application: { className: application.className, path: application.module.path },
    }),
    modify: [
      wire(
        application.module,
        "Application",
        "workflows",
        className,
        className,
        importPath(application.module.path, module),
      ),
      withScripts(root, workflowScripts(workflow, `:${workflow.kebab}`)),
    ],
  };
}
