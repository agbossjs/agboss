import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type FlowPath } from "../../src/flow/ast.js";
import { FlowSyntaxError } from "../../src/flow/builder.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { listOf } from "../../src/flow/dto-wrappers.js";
import { flowLines } from "../../src/flow/print.js";
import { workflowOf } from "../../src/components/assemble.js";
import { CompanyDto } from "./fixtures/data-dtos.js";
import { WorkflowStartTextDto } from "./fixtures/dtos.js";
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
import { router, start } from "./fixtures/paths.js";

/** #263 PR 1 — child workflows in the AST: what the builder writes, what it refuses, the printout. */

const flowOf = (workflow: abstract new () => unknown): readonly FlowPath[] => {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new TypeError("not a workflow");
  return declaration.options.flow;
};

const found = () =>
  start(JobOfferWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(CompanyFinderAgent)
    .returns(listOf(CompanyDto));

describe("#263: a child workflow in the AST", () => {
  it("toWorkflow is a transition of kind workflow; workflow(W) the source of its own path", () => {
    const [, , own] = flowOf(LinkOfferWorkflow);
    expect(flowOf(JobOfferWorkflow)[0]?.steps).toContainEqual({
      kind: StepKind.To,
      target: CompanyReviewWorkflow,
      targetKind: NodeKind.Workflow,
    });
    expect(own?.source).toEqual({ kind: NodeKind.Workflow, node: CompanyReviewWorkflow });
  });

  it("toParallelWorkflows: one child per item, its options as written", () => {
    const launch = flowOf(CompanyScreeningWorkflow)[0]?.steps.find(
      (step) => step.kind === StepKind.Launch,
    );
    expect(launch).toEqual({
      kind: StepKind.Launch,
      targetKind: NodeKind.Workflow,
      targets: [CompanyReviewWorkflow],
      perItem: true,
      maxConcurrency: 3,
      maxItems: 50,
    });
  });

  it("refused: not per item, two children, after a router, a missing join", () => {
    const picked = start(JobOfferWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(CompanyPickerAgent)
      .returns(CompanyDto);
    expect(() => picked.toParallelWorkflows(CompanyReviewWorkflow, { maxItems: 5 })).toThrow(
      new FlowSyntaxError(
        "toParallelWorkflows(W, …) runs one child per item — write .returns(listOf(XDto)) right before it",
      ),
    );
    expect(() =>
      found().toParallelWorkflows(CompanyReviewWorkflow, CompanyReviewWorkflow, { maxItems: 5 }),
    ).toThrow(
      "toParallelWorkflows(W, { maxConcurrency, maxItems }) launches one child workflow class",
    );
    expect(() =>
      router(HelpDeskRouter).toParallelWorkflows(CompanyReviewWorkflow, { maxItems: 5 }),
    ).toThrow("a router launches agents only — .toParallelAgents(…), not toParallelWorkflows(…)");
    expect(() =>
      found()
        .toParallelWorkflows(CompanyReviewWorkflow, { maxItems: 5 })
        .toAgent(CompanyPickerAgent),
    ).toThrow("a parallel launch is followed by .join()");
  });

  it("describe / print: the flow in its grammar — toWorkflow, workflow(W), toParallelWorkflows", () => {
    expect(flowLines(flowOf(CompanyScreeningWorkflow)).slice(0, 6)).toEqual([
      "start(CompanyScreeningWorkflowStart)",
      "  .returns(WorkflowStartTextDto)",
      "  .toAgent(CompanyFinderAgent)",
      "  .returns(listOf(CompanyDto))",
      "  .toParallelWorkflows(CompanyReviewWorkflow, { maxConcurrency: 3, maxItems: 50 })",
      "  .join()",
    ]);
    expect(flowLines(flowOf(LinkOfferWorkflow))).toEqual(
      expect.arrayContaining([
        "  .toWorkflow(CompanyReviewWorkflow)",
        "workflow(CompanyReviewWorkflow)",
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
