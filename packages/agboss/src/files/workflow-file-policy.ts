import { ComponentKind } from "../flow/runtime/records.js";
import type { Class } from "../components/injection.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";

/** Where a workflow's `@FilePolicy` (#1316) is read from its declaration. */

/** The workflow whose flow holds `start`; `undefined` when none does. */
export function workflowOfStart(start: Class, workflows: readonly Class[]): Class | undefined {
  return withChildWorkflows(workflows).find((workflow) => {
    const declaration = declarationOf(workflow);
    return (
      declaration?.kind === ComponentKind.Workflow &&
      flowClassesOf(declaration.options.flow).includes(start)
    );
  });
}

/**
 * The `@FilePolicy` a workflow declares; `undefined` without one. What a profile's `filePolicy` slot or
 * `filePolicies` shelf leaves of it is `ComponentOptions`' to say — every reader asks that.
 */
export function declaredFilePolicyOf(workflow: Class | undefined): Class | undefined {
  const declaration = workflow === undefined ? undefined : declarationOf(workflow);
  return declaration?.kind === ComponentKind.Workflow ? declaration.options.filePolicy : undefined;
}
