import { workflowOf } from "../components/assemble.js";
import type { Class } from "../components/injection.js";
import type { EnvironmentOwner } from "../environments/load.js";
import type { AssembledWorkflow } from "../workflow.js";
import {
  applicationDeclarationOf,
  applicationsListing,
  type ApplicationDeclaration,
} from "./application.js";
import { applicationModule, declaredContextsOf, workflowModules } from "./assemble.js";
import { contextTokensOf } from "../components/context-tokens.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { applicationsNear } from "../loader/application-files.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";

/**
 * One workflow in its application (#261), for what works on a single workflow — `loadWorkflow`, the
 * CLI's `describe` / `check` / `eval`: the one loaded `@Application` that lists
 * it gives its providers, its `defaults` and its environment. Without one the workflow stands alone.
 */

/** The declaration of the one loaded application that lists `workflow`; undefined for none or two. */
export function applicationOfWorkflow(workflow: Class): ApplicationDeclaration | undefined {
  const [only, ...others] = applicationsListing(workflow);
  return only === undefined || others.length > 0 ? undefined : applicationDeclarationOf(only);
}

/**
 * The workflow assembled as its application assembles it: its providers and `defaults` too. An
 * application not loaded yet is looked for next to the workflow's file (`*.application.ts` there or
 * above, as the CLI does).
 */
export async function workflowInApplication(workflow: Class): Promise<AssembledWorkflow> {
  const source = declarationOf(workflow)?.source;
  if (applicationsListing(workflow).length === 0 && source !== undefined)
    await applicationsNear(source, workflow);
  const declaration = applicationOfWorkflow(workflow);
  if (declaration === undefined) return workflowOf(workflow);
  const { options } = declaration;
  const modules = [
    applicationModule(options),
    ...workflowModules(withChildWorkflows(options.workflows)),
  ];
  return workflowOf(workflow, modules, options, contextTokensOf(declaredContextsOf(options)));
}

/** Where the environments of the workflow's application are; one standing alone has none. */
export function environmentOwnerOfWorkflow(workflow: Class): EnvironmentOwner {
  const declaration = applicationOfWorkflow(workflow);
  if (declaration === undefined) return { application: workflow.name };
  return {
    application: declaration.options.name,
    source: declaration.source,
    contract: declaration.options.environment,
  };
}
