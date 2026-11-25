import { StepError } from "../../../src/core/error-families/step-errors.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import {
  onStart,
  toAction,
  toWorkflow,
  onWorkflow,
  toAgent,
  toFinish,
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
import { Integer, List, Text } from "../../../src/dto/index.js";
import { inline, Ttl } from "../../../src/index.js";

/**
 * #264 S112, #1287 — a workflow launching itself with a thunk, typed per path: three recursive
 * workflows whose finishes give other classes than the research of recursion.fixture.ts
 * (`TeamChartDto | OrgChartFailedDto`). `org-chart-workflow`: a per-item launch with its
 * `.onError(…)`; `org-drill-workflow`: `route(() => Self)` and `.toWorkflow(() => Self)` continued
 * on the own path `onWorkflow(() => Self)…`; `org-retry-workflow`: the side-path starter
 * `.onError(E, toWorkflow(() => Self)…)`.
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
  @List(Text, { prompt: "the unit's sub-units" })
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
  prompt: inline("Chart the unit, or list its sub-units."),
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
    const { level } = input.unit;
    return Promise.resolve(input.split.units.map((name) => ({ name, level: level + 1 })));
  }
}

@Agent({
  name: "chart-merger-agent",
  description: "Merges the sub-units' charts",
  prompt: inline("Merge the charts."),
  model: "moonshotai/kimi-k2.6",
  input: { unit: OrgUnitDto, charts: listOf(TeamChartDto, OrgChartFailedDto) },
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
    return Promise.resolve({ name: input.unit.name });
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OrgChartWorkflowStart)
      .toAgent(OrgMapperAgent)
      .toOneOf([
        toFinish(TeamChartWorkflowFinish),
        toAction(SplitUnitAction)
          .forEachItem(
            toWorkflow(() => OrgChartWorkflow),
            { takeFirst: 4, maxConcurrency: 2 },
          )
          .join()
          .onError(
            LimitError,
            toAction(MarkUnitFailedAction)
              .toFinish(OrgChartFailedWorkflowFinish),
          )
          .toAgent(ChartMergerAgent)
          .toFinish(TeamChartWorkflowFinish),
      ]),
  ],
  executionLimits: { maxDepth: 3 },
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
  prompt: inline("Chart the unit, or pick the sub-unit to drill into."),
  model: "moonshotai/kimi-k2.6",
  input: { unit: OrgUnitDto },
  output: oneOf(TeamChartDto, OrgUnitDto),
})
export class UnitPickerAgent {}

/** Deeper while the unit's level is low: `route()` returns the workflow itself or the agent. */
@Router({
  name: "org-depth-router",
  description: "One level deeper, or chart here",
  decidedBy: DecidedBy.Code,
  input: { unit: OrgUnitDto },
  routes: [() => OrgDrillWorkflow, UnitPickerAgent],
})
export class OrgDepthRouter implements RouterHandler<OrgDepthRouter> {
  route(input: InputOf<OrgDepthRouter>): Route<OrgDepthRouter> {
    return input.unit.level < 1 ? OrgDrillWorkflow : UnitPickerAgent;
  }
}

@Workflow({
  name: "org-drill-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OrgDrillWorkflowStart)
      .toRouter(OrgDepthRouter)
      .onRoute(toWorkflow(() => OrgDrillWorkflow))
      .onRoute(
        toAgent(UnitPickerAgent)
          .toOneOf([
            toFinish(TeamChartWorkflowFinish),
            toWorkflow(() => OrgDrillWorkflow),
          ]),
      ),
    onWorkflow(() => OrgDrillWorkflow)
      .onError(StepError, toAction(MarkUnitFailedAction)
        .toFinish(OrgChartFailedWorkflowFinish))
      .toOneOf([toFinish(TeamChartWorkflowFinish), toFinish(OrgChartFailedWorkflowFinish)]),
  ],
  executionLimits: { maxDepth: 3 },
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
  prompt: inline("Chart the unit."),
  model: "moonshotai/kimi-k2.6",
  input: { unit: OrgUnitDto },
  output: TeamChartDto,
})
export class UnitCharterAgent {}

@Workflow({
  name: "org-retry-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OrgRetryWorkflowStart)
      .toAgent(UnitCharterAgent)
      .onError(
        StepError,
        toWorkflow(() => OrgRetryWorkflow)
          .toOneOf([
            toFinish(TeamChartWorkflowFinish),
            toFinish(OrgChartFailedWorkflowFinish),
          ]),
      )
      .toFinish(TeamChartWorkflowFinish),
  ],
  executionLimits: { maxDepth: 2 },
})
export class OrgRetryWorkflow {}
