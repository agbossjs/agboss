import { WorkflowStartTextDto } from "agboss/dto";
import type { ApplicationStart } from "agboss/internal";

export class NoTextStartError extends Error {
  override name = "NoTextStartError";
}

/** `agboss chat` sends what is typed as a text: the chosen start must take `WorkflowStartTextDto`. */
export function textStartOrFail(start: ApplicationStart): ApplicationStart {
  if (start.input !== WorkflowStartTextDto) {
    throw new NoTextStartError(
      `Start "${start.name}" (${start.workflow}) does not take WorkflowStartTextDto: agboss chat sends a text — choose a start that takes one with --start <name>`,
    );
  }
  return start;
}
