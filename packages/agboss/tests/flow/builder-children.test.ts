import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type FlowPath } from "../../src/flow/ast.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { flowLines } from "../../src/flow/print.js";
import { workflowOf } from "../../src/components/assemble.js";
import {
  CompanyFinderAgent,
  CompanyPickerAgent,
  CompanyReviewWorkflow,
  CompanyScreeningWorkflow,
  JobOfferWorkflow,
  JobOfferWorkflowStart,
  LinkOfferWorkflow,
} from "./fixtures/children.fixture.js";
import { HelpDeskRouter } from "./fixtures/launch.fixture.js";
import { onRouter, onStart, toWorkflow } from "./fixtures/paths.js";

/** #263 PR 1 — child workflows in the AST: what the builder writes, what it refuses, the printout. */

const flowOf = (workflow: abstract new () => unknown): readonly FlowPath[] => {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new TypeError("not a workflow");
  return declaration.options.flow;
};

const found = () => onStart(JobOfferWorkflowStart).toAgent(CompanyFinderAgent);

describe("#263: a child workflow in the AST", () => {
  it("toWorkflow is a transition of kind workflow; onWorkflow(W) the source of its own path", () => {
    const [, , own] = flowOf(LinkOfferWorkflow);
    expect(flowOf(JobOfferWorkflow)[0]?.steps).toContainEqual({
      kind: StepKind.To,
      target: CompanyReviewWorkflow,
      targetKind: NodeKind.Workflow,
    });
    expect(own?.source).toEqual({ kind: NodeKind.Workflow, node: CompanyReviewWorkflow });
  });

  it("forEachItem(toWorkflow(W), …): one child per item, its options as written", () => {
    const launch = flowOf(CompanyScreeningWorkflow)[0]?.steps.find(
      (step) => step.kind === StepKind.ForEachItem,
    );
    expect(launch).toMatchObject({
      kind: StepKind.ForEachItem,
      branch: { target: CompanyReviewWorkflow, targetKind: NodeKind.Workflow, skip: [] },
      maxConcurrency: 3,
      takeFirst: 50,
    });
  });

  it("refused: a missing join", () => {
    expect(() =>
      found()
        .forEachItem(toWorkflow(CompanyReviewWorkflow), { takeFirst: 5 })
        .toAgent(CompanyPickerAgent),
    ).toThrow("a parallel launch is followed by .join()");
  });

  it("describe / print: the flow in its grammar — toWorkflow, onWorkflow(W), forEachItem(toWorkflow(W))", () => {
    expect(flowLines(flowOf(CompanyScreeningWorkflow)).slice(0, 4)).toEqual([
      "onStart(CompanyScreeningWorkflowStart)",
      "  .toAgent(CompanyFinderAgent)",
      "  .forEachItem(toWorkflow(CompanyReviewWorkflow), { takeFirst: 50, maxConcurrency: 3 })",
      "  .join()",
    ]);
    expect(flowLines(flowOf(LinkOfferWorkflow))).toEqual(
      expect.arrayContaining([
        "  .toWorkflow(CompanyReviewWorkflow)",
        "onWorkflow(CompanyReviewWorkflow)",
        "  .onError(StepFailedError, toFinish(ReviewErrorWorkflowFinish))",
      ]),
    );
  });
});

describe("#263: a workflow with a child assembles", () => {
  it("the parent assembles with its child as a node (no flow.child-not-runnable since PR 2)", async () => {
    const bundle = await workflowOf(JobOfferWorkflow);
    expect(bundle.graph.nodes.get("company-review-workflow")?.kind).toBe(NodeKind.Workflow);
  });

  it("the child alone assembles: it is an ordinary workflow", async () => {
    await expect(workflowOf(CompanyReviewWorkflow)).resolves.toHaveProperty(
      "config.name",
      "company-review-workflow",
    );
  });
});
