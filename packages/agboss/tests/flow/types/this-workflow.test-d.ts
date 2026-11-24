import { describe, expectTypeOf, it } from "vitest";
import {
  caseOf,
  route,
  onStart,
  toAction,
  toWorkflow,
  onWorkflow,
} from "../../../src/flow/builder.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import type { ThisWorkflowOutputs } from "../../../src/flow/generated-types.js";
import { ThisWorkflow } from "../../../src/flow/this-workflow.js";
import { LimitExceededError } from "../../../src/errors.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import {
  ChartMergerAgent,
  MarkUnitFailedAction,
  OrgChartFailedDto,
  OrgChartFailedWorkflowFinish,
  OrgChartWorkflowStart,
  OrgDepthRouter,
  OrgDrillWorkflowStart,
  OrgMapperAgent,
  OrgSplitDto,
  OrgUnitDto,
  OrgRetryWorkflowStart,
  SplitUnitAction,
  TeamChartDto,
  TeamChartWorkflowFinish,
  UnitCharterAgent,
  UnitPickerAgent,
} from "../fixtures/org-chart.fixture.js";
import {
  DeepResearchWorkflowStart,
  ReportMergerAgent,
  ResearchFailedDto,
  ResearchReportDto,
  ResearchTooBroadDto,
  ResearchTopicDto,
  SplitTopicAction,
  TopicResearcherAgent,
  ResearchReportWorkflowFinish,
} from "../fixtures/recursion.fixture.js";

/**
 * #264 S112, S114 — `ThisWorkflow` typed per path: a `ThisWorkflow` launch is claimed in the path's
 * type and `@Workflow({ name, flow })` checks its launches against `ThisWorkflowOutputs[name]`.
 * What a child gives is derived by the analyser (#1270), so the compile-time pins here are the
 * entry's classes and the claim of a flow without a generated entry.
 */

/** The org chart's path to its switch. */
const orgChartPath = onStart(OrgChartWorkflowStart).toAgent(OrgMapperAgent);

describe("#264 S112: one entry per recursive workflow", () => {
  it("the generated table keys ThisWorkflow by the workflow", () => {
    expectTypeOf<ThisWorkflowOutputs["org-chart-workflow"]["output"]>().toEqualTypeOf<
      TeamChartDto | OrgChartFailedDto
    >();
    expectTypeOf<ThisWorkflowOutputs["deep-research-workflow"]["output"]>().toEqualTypeOf<
      ResearchReportDto | ResearchFailedDto
    >();
    expectTypeOf<ThisWorkflowOutputs["deep-research-workflow"]>().not.toHaveProperty("join");
  });
});

describe("#264 S112: .toParallelWorkflows(ThisWorkflow, …).join()", () => {
  it("a per-item launch of ThisWorkflow is joined and continued", () => {
    Workflow({
      name: "org-chart-workflow",
      version: "1.0.0",
      flow: [
        orgChartPath.switch(
          caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
          caseOf(OrgSplitDto)
            .toAction(SplitUnitAction)
            .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 2, maxItems: 4 })
            .join()
            .toAgent(ChartMergerAgent)
            .toFinish(TeamChartWorkflowFinish),
        ),
      ],
      maxDepth: 3,
    });
    Workflow({
      name: "deep-research-workflow",
      version: "1.0.0",
      flow: [
        onStart(DeepResearchWorkflowStart)
          .toAgent(TopicResearcherAgent)
          .switch(
            caseOf(ResearchReportDto).toFinish(ResearchReportWorkflowFinish),
            caseOf(ResearchTooBroadDto)
              .toAction(SplitTopicAction)
              .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 3, maxItems: 5 })
              .join()
              .toAgent(ReportMergerAgent)
              .toFinish(ResearchReportWorkflowFinish),
          ),
      ],
      maxDepth: 4,
    });
  });
});

describe("#264 S112: a single child — .toWorkflow, route, onWorkflow(…) and the side-path starter", () => {
  const drill = onStart(OrgDrillWorkflowStart).toRouter(OrgDepthRouter);
  const failed = toAction(MarkUnitFailedAction).toFinish(OrgChartFailedWorkflowFinish);

  it("each form names its own workflow's classes", () => {
    Workflow({
      name: "org-drill-workflow",
      version: "1.0.0",
      flow: [
        drill.chooseOne(
          route(ThisWorkflow)
            .onError(StepFailedError, failed)
            .switch(
              caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
              caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
            ),
          route(UnitPickerAgent).switch(
            caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
            caseOf(OrgUnitDto)
              .toWorkflow(ThisWorkflow)
              .switch(
                caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
                caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
              ),
          ),
        ),
        onWorkflow(ThisWorkflow).switch(
          caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
          caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
        ),
      ],
      maxDepth: 3,
    });
    Workflow({
      name: "org-retry-workflow",
      version: "1.0.0",
      flow: [
        onStart(OrgRetryWorkflowStart)
          .toAgent(UnitCharterAgent)
          .onError(
            StepFailedError,
            toWorkflow(ThisWorkflow).switch(
              caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
              caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
            ),
          )
          .toFinish(TeamChartWorkflowFinish),
      ],
      maxDepth: 2,
    });
  });

  it("a workflow with no generated entry is told to run agboss check", () => {
    Workflow({
      name: "unchecked-workflow",
      version: "1.0.0",
      // @ts-expect-error — no ThisWorkflowOutputs["unchecked-workflow"] before agboss check
      flow: [
        onStart(OrgRetryWorkflowStart).toWorkflow(ThisWorkflow).toFinish(TeamChartWorkflowFinish),
      ],
      maxDepth: 2,
    });
  });

  it("a flow that never launches ThisWorkflow needs no entry", () => {
    Workflow({
      name: "unchecked-workflow",
      version: "1.0.0",
      flow: [
        onStart(OrgRetryWorkflowStart).toAgent(UnitCharterAgent).toFinish(TeamChartWorkflowFinish),
      ],
    });
  });
});
