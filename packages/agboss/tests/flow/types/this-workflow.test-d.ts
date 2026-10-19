import { describe, expectTypeOf, it } from "vitest";
import { caseOf, route, start, toAction, toWorkflow, workflow } from "../../../src/flow/builder.js";
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
 * #264 S112, S114 — `ThisWorkflow` typed per path: a `.returns(…)` after a `ThisWorkflow` launch is
 * claimed in the path's type and `@Workflow({ name, flow })` checks it against
 * `ThisWorkflowOutputs[name]`. The fixtures' recursive workflows give different classes — the
 * research `ResearchReportDto | ResearchFailedDto`, the org charts `TeamChartDto |
 * OrgChartFailedDto` — and each launch form is typed by its own workflow. Each `@ts-expect-error`
 * is a negative test: the wrong class fails on `flow`.
 */

/** The org chart's per-item launch, joined as `listOf(TJoined)`. */
const orgChartPath = start(OrgChartWorkflowStart)
  .returns(OrgUnitDto)
  .toAgent(OrgMapperAgent)
  .returns(oneOf(TeamChartDto, OrgSplitDto));

describe("#264 S112: one entry per recursive workflow", () => {
  it("the generated table keys ThisWorkflow by the workflow", () => {
    expectTypeOf<ThisWorkflowOutputs["org-chart-workflow"]["output"]>().toEqualTypeOf<
      TeamChartDto | OrgChartFailedDto
    >();
    expectTypeOf<ThisWorkflowOutputs["deep-research-workflow"]["join"]>().toEqualTypeOf<
      readonly (ResearchReportDto | ResearchFailedDto)[]
    >();
  });
});

describe("#264 S112: .toParallelWorkflows(ThisWorkflow, …).join().returns(listOf(…))", () => {
  it("each workflow's join is a list of its own finishes' classes", () => {
    Workflow({
      name: "org-chart-workflow",
      version: "1.0.0",
      flow: [
        orgChartPath.switch(
          caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
          caseOf(OrgSplitDto)
            .toAction(SplitUnitAction)
            .returns(listOf(OrgUnitDto))
            .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 2, maxItems: 4 })
            .join()
            .returns(listOf(oneOf(TeamChartDto, OrgChartFailedDto)))
            .toAgent(ChartMergerAgent)
            .returns(TeamChartDto)
            .toFinish(TeamChartWorkflowFinish),
        ),
      ],
      maxDepth: 3,
    });
    Workflow({
      name: "deep-research-workflow",
      version: "1.0.0",
      flow: [
        start(DeepResearchWorkflowStart)
          .returns(ResearchTopicDto)
          .toAgent(TopicResearcherAgent)
          .returns(oneOf(ResearchReportDto, ResearchTooBroadDto))
          .switch(
            caseOf(ResearchReportDto).toFinish(ResearchReportWorkflowFinish),
            caseOf(ResearchTooBroadDto)
              .toAction(SplitTopicAction)
              .returns(listOf(ResearchTopicDto))
              .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 3, maxItems: 5 })
              .join()
              .returns(listOf(oneOf(ResearchReportDto, ResearchFailedDto)))
              .toAgent(ReportMergerAgent)
              .returns(ResearchReportDto)
              .toFinish(ResearchReportWorkflowFinish),
          ),
      ],
      maxDepth: 4,
    });
  });

  it("the research's classes are not what the org chart's children give", () => {
    Workflow({
      name: "org-chart-workflow",
      version: "1.0.0",
      // @ts-expect-error — the org chart's children give TeamChartDto | OrgChartFailedDto
      flow: [
        orgChartPath.switch(
          caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
          caseOf(OrgSplitDto)
            .toAction(SplitUnitAction)
            .returns(listOf(OrgUnitDto))
            .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 2, maxItems: 4 })
            .join()
            .returns(listOf(oneOf(ResearchReportDto, ResearchFailedDto)))
            .toFinish(TeamChartWorkflowFinish),
        ),
      ],
      maxDepth: 3,
    });
  });

  it("a join without one of the classes does not compile", () => {
    Workflow({
      name: "org-chart-workflow",
      version: "1.0.0",
      // @ts-expect-error — the join gives OrgChartFailedDto too
      flow: [
        orgChartPath.switch(
          caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
          caseOf(OrgSplitDto)
            .toAction(SplitUnitAction)
            .returns(listOf(OrgUnitDto))
            .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 2, maxItems: 4 })
            .join()
            .returns(listOf(TeamChartDto))
            .toFinish(TeamChartWorkflowFinish),
        ),
      ],
      maxDepth: 3,
    });
  });

  it("a ThisWorkflow launch in an .onJoinError side path is checked too", () => {
    Workflow({
      name: "org-chart-workflow",
      version: "1.0.0",
      // @ts-expect-error — the side path's child gives TeamChartDto | OrgChartFailedDto
      flow: [
        orgChartPath.switch(
          caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
          caseOf(OrgSplitDto)
            .toAction(SplitUnitAction)
            .returns(listOf(OrgUnitDto))
            .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 2, maxItems: 4 })
            .join()
            .onJoinError(
              LimitExceededError,
              toWorkflow(ThisWorkflow).returns(ResearchReportDto).toFinish(TeamChartWorkflowFinish),
            )
            .returns(listOf(oneOf(TeamChartDto, OrgChartFailedDto)))
            .toFinish(TeamChartWorkflowFinish),
        ),
      ],
      maxDepth: 3,
    });
  });
});

describe("#264 S112: a single child — .toWorkflow, route, workflow(…) and the side-path starter", () => {
  const drill = start(OrgDrillWorkflowStart).returns(OrgUnitDto).toRouter(OrgDepthRouter);
  const failed = toAction(MarkUnitFailedAction)
    .returns(OrgChartFailedDto)
    .toFinish(OrgChartFailedWorkflowFinish);

  it("each form names its own workflow's classes", () => {
    Workflow({
      name: "org-drill-workflow",
      version: "1.0.0",
      flow: [
        drill.chooseOne(
          route(ThisWorkflow)
            .onError(StepFailedError, failed)
            .returns(oneOf(TeamChartDto, OrgChartFailedDto))
            .switch(
              caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
              caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
            ),
          route(UnitPickerAgent)
            .returns(oneOf(TeamChartDto, OrgUnitDto))
            .switch(
              caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
              caseOf(OrgUnitDto)
                .toWorkflow(ThisWorkflow)
                .returns(oneOf(TeamChartDto, OrgChartFailedDto))
                .switch(
                  caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
                  caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
                ),
            ),
        ),
        workflow(ThisWorkflow)
          .returns(oneOf(OrgChartFailedDto, TeamChartDto))
          .switch(
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
        start(OrgRetryWorkflowStart)
          .returns(OrgUnitDto)
          .toAgent(UnitCharterAgent)
          .onError(
            StepFailedError,
            toWorkflow(ThisWorkflow)
              .returns(oneOf(TeamChartDto, OrgChartFailedDto))
              .switch(
                caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
                caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
              ),
          )
          .returns(TeamChartDto)
          .toFinish(TeamChartWorkflowFinish),
      ],
      maxDepth: 2,
    });
  });

  it("route(ThisWorkflow) with the research's classes does not compile", () => {
    Workflow({
      name: "org-drill-workflow",
      version: "1.0.0",
      // @ts-expect-error — route(ThisWorkflow) gives TeamChartDto | OrgChartFailedDto
      flow: [
        drill.chooseOne(
          route(ThisWorkflow)
            .returns(oneOf(ResearchReportDto, ResearchFailedDto))
            .switch(
              caseOf(ResearchReportDto).toFinish(TeamChartWorkflowFinish),
              caseOf(ResearchFailedDto).toFinish(OrgChartFailedWorkflowFinish),
            ),
          route(UnitPickerAgent)
            .returns(oneOf(TeamChartDto, OrgUnitDto))
            .switch(
              caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
              caseOf(OrgUnitDto).toFinish(TeamChartWorkflowFinish),
            ),
        ),
      ],
      maxDepth: 3,
    });
  });

  it(".toWorkflow(ThisWorkflow) in a case with one class too few does not compile", () => {
    Workflow({
      name: "org-drill-workflow",
      version: "1.0.0",
      // @ts-expect-error — .toWorkflow(ThisWorkflow) gives OrgChartFailedDto too
      flow: [
        drill.chooseOne(
          route(ThisWorkflow),
          route(UnitPickerAgent)
            .returns(oneOf(TeamChartDto, OrgUnitDto))
            .switch(
              caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
              caseOf(OrgUnitDto)
                .toWorkflow(ThisWorkflow)
                .returns(TeamChartDto)
                .toFinish(TeamChartWorkflowFinish),
            ),
        ),
      ],
      maxDepth: 3,
    });
  });

  it("workflow(ThisWorkflow)'s own path with the research's classes does not compile", () => {
    Workflow({
      name: "org-drill-workflow",
      version: "1.0.0",
      // @ts-expect-error — workflow(ThisWorkflow) gives TeamChartDto | OrgChartFailedDto
      flow: [
        drill.chooseOne(route(ThisWorkflow), route(UnitPickerAgent)),
        workflow(ThisWorkflow).returns(ResearchReportDto).toFinish(TeamChartWorkflowFinish),
      ],
      maxDepth: 3,
    });
  });

  it("a ThisWorkflow launch in an .onError side path is checked too", () => {
    Workflow({
      name: "org-retry-workflow",
      version: "1.0.0",
      // @ts-expect-error — the side path's child gives TeamChartDto | OrgChartFailedDto
      flow: [
        start(OrgRetryWorkflowStart)
          .returns(OrgUnitDto)
          .toAgent(UnitCharterAgent)
          .onError(
            StepFailedError,
            toWorkflow(ThisWorkflow)
              .returns(oneOf(ResearchReportDto, ResearchFailedDto))
              .switch(
                caseOf(ResearchReportDto).toFinish(TeamChartWorkflowFinish),
                caseOf(ResearchFailedDto).toFinish(OrgChartFailedWorkflowFinish),
              ),
          )
          .returns(TeamChartDto)
          .toFinish(TeamChartWorkflowFinish),
      ],
      maxDepth: 2,
    });
  });

  it("a side path of a ThisWorkflow step is checked with it", () => {
    Workflow({
      name: "org-retry-workflow",
      version: "1.0.0",
      // @ts-expect-error — the nested child gives TeamChartDto | OrgChartFailedDto
      flow: [
        start(OrgRetryWorkflowStart)
          .returns(OrgUnitDto)
          .toWorkflow(ThisWorkflow)
          .onError(
            StepFailedError,
            toWorkflow(ThisWorkflow)
              .returns(ResearchFailedDto)
              .toFinish(OrgChartFailedWorkflowFinish),
          )
          .returns(oneOf(TeamChartDto, OrgChartFailedDto))
          .switch(
            caseOf(TeamChartDto).toFinish(TeamChartWorkflowFinish),
            caseOf(OrgChartFailedDto).toFinish(OrgChartFailedWorkflowFinish),
          ),
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
        start(OrgRetryWorkflowStart)
          .returns(OrgUnitDto)
          .toWorkflow(ThisWorkflow)
          .returns(TeamChartDto)
          .toFinish(TeamChartWorkflowFinish),
      ],
      maxDepth: 2,
    });
  });

  it("a flow that never launches ThisWorkflow needs no entry", () => {
    Workflow({
      name: "unchecked-workflow",
      version: "1.0.0",
      flow: [
        start(OrgRetryWorkflowStart)
          .returns(OrgUnitDto)
          .toAgent(UnitCharterAgent)
          .returns(TeamChartDto)
          .toFinish(TeamChartWorkflowFinish),
      ],
    });
  });
});
