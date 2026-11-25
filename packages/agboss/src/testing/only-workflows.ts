import type { AssembledApplication } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { TestSetupError } from "./errors.js";

/** The workflow classes a name belongs to, by their declared names. */
const workflowNameOf = (workflow: Class): string | undefined =>
  declarationOf(workflow)?.options.name;

/** The application with only the workflows `only` names, and the child workflows they launch. */
export function onlyWorkflows(
  assembled: AssembledApplication,
  only: readonly Class[],
): AssembledApplication {
  const known = new Set(assembled.workflows.map((workflow) => workflow.config.name));
  for (const workflow of only) {
    const name = workflowNameOf(workflow);
    if (name === undefined || !known.has(name)) {
      throw new TestSetupError({
        message: `only: [${workflow.name}] — not a workflow of ${assembled.name}`,
      });
    }
  }
  const kept = new Set(
    withChildWorkflows(only).flatMap((workflow) => workflowNameOf(workflow) ?? []),
  );
  return {
    ...assembled,
    workflows: assembled.workflows.filter((workflow) => kept.has(workflow.config.name)),
  };
}
