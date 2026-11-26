import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { declaredExecutionLimitsOf } from "../../../src/flow/decorators/workflow.js";
/**
 * #1366: the steps a flow's worst case counts against its `maxSteps` — the most steps of the flow when they fit
 * within `maxSteps` (a flow of exactly that many fits), the limit itself when they do not, the limit named among the
 * parts of the case.
 */
import { describe, expect, it } from "vitest";
import { worstCasesOf } from "../../../src/flow/analyse/worst-case.js";
import { graphOf, edge, node } from "./graph-fixture.js";

const Desk = Object;

/** start -> agent A -> agent B -> finish: two working steps. */
const graph = graphOf(
  [
    node("S", ComponentKind.WorkflowStart),
    node("A", ComponentKind.Agent),
    node("B", ComponentKind.Agent),
    node("F", ComponentKind.WorkflowFinish),
  ],
  [edge("S", "A"), edge("A", "B"), edge("B", "F")],
  ["S"],
);

const caseWith = (maxSteps: number | undefined) =>
  worstCasesOf(
    graph,
    maxSteps === undefined ? {} : { maxSteps },
    Desk,
    declaredExecutionLimitsOf,
  )[0];

describe("#1366: the worst case of a flow against its maxSteps", () => {
  it("a flow of exactly maxSteps steps fits: its steps, not capped", () => {
    expect(caseWith(2)).toMatchObject({ steps: 2, isStepsCapped: false, treeSteps: 2 });
    expect(caseWith(2)?.parts).toEqual([]);
  });

  it("a flow of more steps than maxSteps is capped at it, and says so", () => {
    expect(caseWith(1)).toMatchObject({ steps: 1, isStepsCapped: true, treeSteps: 1 });
    expect(caseWith(1)?.parts).toEqual(["maxSteps 1"]);
  });

  it("a flow of fewer steps fits whatever maxSteps allows, and the default allows three a working step", () => {
    expect(caseWith(10)).toMatchObject({ steps: 2, isStepsCapped: false });
    expect(caseWith(undefined)).toMatchObject({ steps: 2, isStepsCapped: false });
  });
});
