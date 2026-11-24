import type { ExecutionSpanFrame } from "../../core/diagnostics/span-trace.js";
import { declarationOf } from "../decorators/declaration.js";
import type { ExecutionFacts } from "./frame.js";
import type { StepDescriptor } from "./execution-context.js";

/**
 * The `Span trace` of an error made inside a step (#1325c): the step — its component kind, its node
 * id, its visit number — then each workflow run around it, the innermost first, up to the root's.
 * Names and counters only: no tenant, no id of an execution, thread or tool call, no value of the
 * run's data.
 */
export function spanFramesOf(
  step: StepDescriptor,
  execution: ExecutionFacts,
): readonly ExecutionSpanFrame[] {
  const span = declarationOf(step.component.type)?.span;
  const frames: ExecutionSpanFrame[] = [
    {
      name: `agboss::${step.component.kind}::run`,
      fields: { node: step.nodeId, visit: step.visitNumber },
      ...(span === undefined ? {} : { location: span }),
    },
  ];
  for (
    let run: ExecutionFacts | undefined = execution;
    run !== undefined;
    run = run.parent?.execution
  ) {
    const workflow = declarationOf(run.workflow.type)?.span;
    frames.push({
      name: "agboss::workflow::run",
      fields: { workflow: run.workflow.name, version: run.workflow.version },
      ...(workflow === undefined ? {} : { location: workflow }),
    });
  }
  return frames;
}
