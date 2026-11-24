import type { Class } from "../components/injection.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";

/** Where a workflow's `@FilePolicy` (#1316) is read from its declaration. */

/** The workflow whose flow holds `start`; `undefined` when none does. */
export function workflowOfStart(start: Class, workflows: readonly Class[]): Class | undefined {
  return withChildWorkflows(workflows).find((workflow) => {
    const declaration = declarationOf(workflow);
    return (
      declaration?.kind === NodeKind.Workflow &&
      flowClassesOf(declaration.options.flow).includes(start)
    );
  });
}

/** The `@FilePolicy` of a workflow; `undefined` without one. */
export function workflowFilePolicyOf(workflow: Class | undefined): Class | undefined {
  const declaration = workflow === undefined ? undefined : declarationOf(workflow);
  return declaration?.kind === NodeKind.Workflow ? declaration.options.filePolicy : undefined;
}
