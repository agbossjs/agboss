import {
  caseOf,
  route,
  start,
  toAction,
  toWorkflow,
  workflow,
} from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf, Route } from "../../../src/flow/generated-types.js";
import type { ActionHandler, RouterHandler } from "../../../src/flow/handlers.js";
import { ThisWorkflow } from "../../../src/flow/this-workflow.js";
import { LimitExceededError } from "../../../src/errors.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { Integer, ListOf, Text } from "../../../src/dto/index.js";

/**
 * #264 S112 — `ThisWorkflow` typed per path: three recursive workflows whose finishes give other
 * classes than the research of recursion.fixture.ts (`TeamChartDto | OrgChartFailedDto`), each typed
 * by its own `ThisWorkflowOutputs` entry. `org-chart-workflow`: a per-item launch with its
 * `.onJoinError(…)`; `org-drill-workflow`: `route(ThisWorkflow)` and `.toWorkflow(ThisWorkflow)`
 * continued on the own path `workflow(ThisWorkflow)…`; `org-retry-workflow`: the side-path starter
 * `.onError(E, toWorkflow(ThisWorkflow)…)`.
 */

export class OrgUnitDto {
  @Text({ prompt: "the unit" })
  name!: string;

  @Integer({ prompt: "the unit's level: 0 for the whole company" })
  level!: number;
}

export class TeamChartDto {
  @Text({ prompt: "the unit's chart" })
  chart!: string;
}

export class OrgSplitDto {
  @ListOf(Text, { prompt: "the unit's sub-units" })
  units!: string[];
}

export class OrgChartFailedDto {
  @Text({ prompt: "the unit" })
  name!: string;
}

@WorkflowStart({
  name: "org-chart-workflow-start",
  description: "A unit to chart",
  input: OrgUnitDto,
})
export class OrgChartWorkflowStart {}

@Agent({
  name: "org-mapper-agent",
  description: "Charts a unit, or lists its sub-units",
  prompt: "Chart the unit, or list its sub-units.",
  model: "moonshotai/kimi-k2.6",
  input: { unit: OrgUnitDto },
  output: oneOf(TeamChartDto, OrgSplitDto),
})
export class OrgMapperAgent {}

@Action({
  name: "split-unit-action",
  description: "Splits a unit into its sub-units",
  input: { unit: OrgUnitDto, split: OrgSplitDto },
  output: listOf(OrgUnitDto),
})
export class SplitUnitAction implements ActionHandler<SplitUnitAction> {
  execute(input: InputOf<SplitUnitAction>): Promise<OutputOf<SplitUnitAction>> {
    const { level } = input.unit.value;
    return Promise.resolve(input.split.value.units.map((name) => ({ name, level: level + 1 })));
  }
}

@Agent({
  name: "chart-merger-agent",
  description: "Merges the sub-units' charts",
  prompt: "Merge the charts.",
  model: "moonshotai/kimi-k2.6",
  input: { unit: OrgUnitDto, charts: listOf(oneOf(TeamChartDto, OrgChartFailedDto)) },
  output: TeamChartDto,
})
export class ChartMergerAgent {}

@Action({
  name: "mark-unit-failed-action",
  description: "Records a unit that could not be charted",
  input: { unit: OrgUnitDto },
  output: OrgChartFailedDto,
})
export class MarkUnitFailedAction implements ActionHandler<MarkUnitFailedAction> {
  execute(input: InputOf<MarkUnitFailedAction>): Promise<OutputOf<MarkUnitFailedAction>> {
    return Promise.resolve({ name: input.unit.value.name });
  }
}

@WorkflowFinish({
  name: "team-chart-workflow-finish",
  description: "The chart",
  output: TeamChartDto,
})
export class TeamChartWorkflowFinish {}

@WorkflowFinish({
  name: "org-chart-failed-workflow-finish",
  description: "No chart",
  output: OrgChartFailedDto,
})
export class OrgChartFailedWorkflowFinish {}

@Workflow({
  name: "org-chart-workflow",
  version: "1.0.0",
  flow: [
    start(OrgChartWorkflowStart)
      .returns(OrgUnitDto)
      .toAgent(OrgMapperAgent)
      .returns(oneOf(TeamChartDto, OrgSplitDto))
      .switch(
        caseOf(TeamChartDto)
          .toFinish(TeamChartWorkflowFinish),
        caseOf(OrgSplitDto)
          .toAction(SplitUnitAction)
          .returns(listOf(OrgUnitDto))
          .toParallelWorkflows(ThisWorkflow, { maxConcurrency: 2, maxItems: 4 })
          .join()
          .onJoinError(
            LimitExceededError,
            toAction(MarkUnitFailedAction)
              .returns(OrgChartFailedDto)
              .toFinish(OrgChartFailedWorkflowFinish),
          )
          .returns(listOf(oneOf(TeamChartDto, OrgChartFailedDto)))
          .toAgent(ChartMergerAgent)
          .returns(TeamChartDto)
          .toFinish(TeamChartWorkflowFinish),
      ),
  ],
  maxDepth: 3,
})
export class OrgChartWorkflow {}

@WorkflowStart({
  name: "org-drill-workflow-start",
  description: "A unit to drill into",
  input: OrgUnitDto,
})
export class OrgDrillWorkflowStart {}

@Agent({
  name: "unit-picker-agent",
  description: "Charts a unit, or picks the one sub-unit to drill into",
  prompt: "Chart the unit, or pick the sub-unit to drill into.",
  model: "moonshotai/kimi-k2.6",
  input: { unit: OrgUnitDto },
  output: oneOf(TeamChartDto, OrgUnitDto),
})
export class UnitPickerAgent {}

/** Deeper while the unit's level is low: `route()` returns `typeof ThisWorkflow` or the agent. */
@Router({
  name: "org-depth-router",
  description: "One level deeper, or chart here",
  decidedBy: DecidedBy.Code,
  input: { unit: OrgUnitDto },
  routes: [{ target: ThisWorkflow }, { target: UnitPickerAgent }],
})
export class OrgDepthRouter implements RouterHandler<OrgDepthRouter> {
  route(input: InputOf<OrgDepthRouter>): Route<OrgDepthRouter> {
    return input.unit.value.level < 1 ? ThisWorkflow : UnitPickerAgent;
  }
}

@Workflow({
  name: "org-drill-workflow",
  version: "1.0.0",
  flow: [
    start(OrgDrillWorkflowStart)
      .returns(OrgUnitDto)
      .toRouter(OrgDepthRouter)
      .chooseOne(
        route(ThisWorkflow),
        route(UnitPickerAgent)
          .returns(oneOf(TeamChartDto, OrgUnitDto))
          .switch(
            caseOf(TeamChartDto)
              .toFinish(TeamChartWorkflowFinish),
            caseOf(OrgUnitDto)
              .toWorkflow(ThisWorkflow),
          ),
      ),
    workflow(ThisWorkflow)
      .onError(
        StepFailedError,
        toAction(MarkUnitFailedAction)
          .returns(OrgChartFailedDto)
          .toFinish(OrgChartFailedWorkflowFinish),
      )
      .returns(oneOf(TeamChartDto, OrgChartFailedDto))
      .switch(
        caseOf(TeamChartDto)
          .toFinish(TeamChartWorkflowFinish),
        caseOf(OrgChartFailedDto)
          .toFinish(OrgChartFailedWorkflowFinish),
      ),
  ],
  maxDepth: 3,
})
export class OrgDrillWorkflow {}

@WorkflowStart({
  name: "org-retry-workflow-start",
  description: "A unit to chart, one level deeper when charting fails",
  input: OrgUnitDto,
})
export class OrgRetryWorkflowStart {}

@Agent({
  name: "unit-charter-agent",
  description: "Charts a unit",
  prompt: "Chart the unit.",
  model: "moonshotai/kimi-k2.6",
  input: { unit: OrgUnitDto },
  output: TeamChartDto,
})
export class UnitCharterAgent {}

@Workflow({
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
            caseOf(TeamChartDto)
              .toFinish(TeamChartWorkflowFinish),
            caseOf(OrgChartFailedDto)
              .toFinish(OrgChartFailedWorkflowFinish),
          ),
      )
      .returns(TeamChartDto)
      .toFinish(TeamChartWorkflowFinish),
  ],
  maxDepth: 2,
})
export class OrgRetryWorkflow {}
