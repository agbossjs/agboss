import { validate } from "../../../dto/schema.js";
import type { GraphDeps } from "../../../graph/deps.js";
import { NodeKind } from "../../ast.js";
import type { RuntimeGraph, RuntimeNode } from "../graph-model.js";
import { runGuards } from "../guards.js";
import type { NodeRunner } from "../node-runner.js";
import { OutputInvalidError } from "../errors.js";
import { readInput, type ScopeView } from "../scope.js";
import type { ScopeRecords } from "../records.js";

/** What a finish with `input` is: `finish(input)` builds the execution's output. */
interface FinishHandlerInstance {
  finish(input: Readonly<Record<string, unknown>>): unknown;
}

const isHandler = (value: unknown): value is FinishHandlerInstance =>
  typeof value === "object" &&
  value !== null &&
  "finish" in value &&
  typeof value.finish === "function";

/** A pass-through finish (#270 Q50): the latest value of its `output` type on the path. */
function passedThrough(node: RuntimeNode, scope: ScopeRecords) {
  const [field] = node.fields;
  const record = field === undefined ? undefined : scope[field.slot];
  return { value: record?.value, read: record === undefined ? [] : [record.valueId] };
}

async function handled(
  graph: RuntimeGraph,
  node: RuntimeNode,
  deps: GraphDeps<string>,
  view: ScopeView,
) {
  const instance: unknown = deps.container.get(node.component);
  if (!isHandler(instance)) {
    throw new OutputInvalidError(
      `${node.id} has input but no finish(input) — implement FinishHandler`,
    );
  }
  const input = readInput(graph, node, view);
  return { value: await instance.finish(input.fields), read: input.read };
}

/**
 * A workflow finish: its handler (`finish(input)`) or the pass-through, the result checked against
 * its `output` DTO, then the output guards. The output is the execution's `result.output`.
 */
export function finishRunner(node: RuntimeNode, deps: GraphDeps<string>): NodeRunner {
  const { declaration } = node;
  if (declaration.kind !== NodeKind.Finish) throw new TypeError(`${node.id} is not a finish`);
  const { output, input } = declaration.options;
  return async (state) => {
    const built =
      input === undefined
        ? passedThrough(node, state.scope)
        : await handled(deps.graph, node, deps, state);
    const checked = validate(output, built.value);
    const usage = await runGuards(deps.guards.output, checked);
    return { finish: { output: checked }, read: built.read, usage };
  };
}
