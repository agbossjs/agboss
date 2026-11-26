import { ComponentKind } from "../flow/runtime/records.js";
import { CostReport } from "../finops/usage.js";
import { hydrated } from "../dto/hydrate.js";
import { strictMatchOf } from "../dto/schema.js";
import { listItemClassesOf, plainOutputClassOf } from "../flow/finish-output.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { finishLineParts } from "../flow/runtime/history.js";
import { ExecutionRecordStatus } from "../infrastructure/execution-record.repository.js";
import type { Turn } from "../turns/index.js";

/**
 * What an answered tree's record keeps of its end (#1321d, Q11): its checkpoints are gone with the
 * tree's end (`forgetTree`), so a late resume or a state read finds the result here — the finish
 * (the last node of its route, or the name its finish line holds), the output (the finish line's
 * JSON, already masked when it was written, with its finish DTO's prototype, #1288) and the spend
 * (the record's cost). `undefined` for a record that did not answer.
 */
export interface EndedResult {
  readonly finish: string;
  readonly output: unknown;
  readonly spend: CostReport;
}

/** The output as an instance of its finish's DTO (a list: of each item's class); unknown stays plain. */
function hydratedOutput(
  graph: Pick<RuntimeGraph, "nodes">,
  finish: string,
  output: unknown,
): unknown {
  const declaration = graph.nodes.get(finish)?.declaration;
  if (declaration?.kind !== ComponentKind.WorkflowFinish) return output;
  const dto = plainOutputClassOf(declaration.options.output);
  if (dto !== undefined) return hydrated(dto, output);
  const items = listItemClassesOf(declaration.options.output);
  if (!Array.isArray(output)) return output;
  return (output as readonly unknown[]).map((item) => {
    const [only] = items;
    const dtoOf = items.length === 1 ? only : strictMatchOf(items, item);
    return dtoOf === undefined ? item : hydrated(dtoOf, item);
  });
}

/** The result an answered record keeps; see `EndedResult`. */
export function endedResultOf(
  graph: Pick<RuntimeGraph, "nodes">,
  record: Turn,
): EndedResult | undefined {
  // text: a record's status may be compared with the repository's statuses
  const status: string = record.status;
  if (status !== (ExecutionRecordStatus.Answered as string)) return undefined;
  const parts = finishLineParts(record.replyWith);
  const finish = parts?.name ?? record.route.at(-1) ?? "";
  if (finish === "") return undefined;
  return {
    finish,
    output: parts === undefined ? undefined : hydratedOutput(graph, finish, parts.output),
    spend: { ...CostReport.empty(), totalUsd: record.costUsd },
  };
}
