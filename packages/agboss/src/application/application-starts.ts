import type { Class } from "../components/injection.js";
import { NodeKind } from "../flow/ast.js";
import { childWorkflowOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { WorkflowStartInput } from "../flow/decorators/workflow-start.js";
import type { ComponentName } from "../flow/registry.js";
import { requireApplication } from "./application.js";

/**
 * The starts of an application (#268): where `app.execute` may begin — every start of every
 * workflow it runs (the ones listed, then the child workflows they launch, #263). Read from the
 * decorators only: nothing is assembled, no project code runs. The CLI chooses one by its full name
 * (`--start screening-workflow-start`).
 */

/** One start of an application: its name, what it is for, the workflow it opens and its input. */
export interface ApplicationStart {
  readonly name: ComponentName;
  readonly description: string;
  /** The `name` of the workflow the start opens. */
  readonly workflow: string;
  readonly component: Class;
  /** `@WorkflowStart({ input })`: one DTO, a `listOf(…)` or a map of fields. */
  readonly input: WorkflowStartInput;
}

function startOf(name: ComponentName, component: Class, workflow: string): ApplicationStart[] {
  const declaration = declarationOf(component);
  if (declaration?.kind !== NodeKind.Start) return [];
  const { description, input } = declaration.options;
  return [{ name, description, workflow, component, input }];
}

/** Every start of the application, workflow by workflow in the order they are listed. */
export function startsOfApplication(
  application: Class,
  where = "agboss",
): readonly ApplicationStart[] {
  const { options } = requireApplication(application, where);
  return withChildWorkflows(options.workflows).flatMap((workflow) => {
    const child = childWorkflowOf(workflow);
    if (child === undefined) return [];
    return child.starts.flatMap((start) => startOf(start.name, start.component, child.name));
  });
}
