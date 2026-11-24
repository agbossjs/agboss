import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { EdgeKind, isTextAgent } from "../../../src/flow/analyse/flow-graph.js";
import { shapeLabel } from "../../../src/flow/analyse/labels.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { NodeKind } from "../../../src/flow/ast.js";
import type { Class } from "../../../src/components/injection.js";
import { FIXTURE_WORKFLOWS } from "../types/fixture-workflows.js";

/**
 * #1270a: the graph carries what each step's declaration gives; where the flow still writes
 * `.returns(…)`, the two agree (the whole fixture corpus is the proof, until 1270b removes it).
 */

const isWorkflow = (value: unknown): value is Class =>
  typeof value === "function" && declarationOf(value)?.kind === NodeKind.Workflow;

async function cleanWorkflows(): Promise<readonly [string, Class][]> {
  const found: [string, Class][] = [];
  for (const file of FIXTURE_WORKFLOWS) {
    const module = (await import(file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (isWorkflow(value) && checkWorkflow(value).errors.length === 0) found.push([name, value]);
    }
  }
  return found;
}

const labels = (writes: readonly { readonly shape: Parameters<typeof shapeLabel>[0] }[]) =>
  writes.map((write) => shapeLabel(write.shape)).sort();

describe("#1270a: the derived values equal the written .returns(…)", async () => {
  const workflows = await cleanWorkflows();

  it("the fixtures have workflows to compare", () => {
    expect(workflows.length).toBeGreaterThan(10);
  });

  it.each(workflows)(
    "%s: every edge's values are what its step's declaration gives",
    (_, workflow) => {
      const { analysis } = checkWorkflow(workflow);
      for (const edge of analysis?.graph.edges ?? []) {
        const node = analysis?.graph.nodes.get(edge.from);
        if (node === undefined || isTextAgent(node)) continue;
        if (edge.kind === EdgeKind.Next || edge.kind === EdgeKind.Route)
          expect(labels(edge.writes)).toEqual(labels(edge.returned));
        if (edge.join !== undefined)
          expect(labels(edge.join.values)).toEqual(
            labels(edge.join.written.map((shape) => ({ shape }))),
          );
      }
    },
  );
});
