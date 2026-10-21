// `agboss check` fixture (#268 AC5): a batch launching one child workflow per item; the report
// reads the decorators only — every budget's maxSpend() throws, so a report that called project
// code would fail
// the untyped builder: this package has no generated types for the framework's fixtures
import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  EmptyEnvironment,
  type BudgetHandler,
} from "../../../../agboss/src/index.js";
import { Action } from "../../../../agboss/src/flow/decorators/action.js";
import { Agent } from "../../../../agboss/src/flow/decorators/agent.js";
import { Workflow } from "../../../../agboss/src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../agboss/src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../agboss/src/flow/decorators/workflow-start.js";
import { listOf } from "../../../../agboss/src/flow/dto-wrappers.js";
import { Text } from "../../../../agboss/src/dto/index.js";
import type { Usd } from "../../../../agboss/src/units/index.js";
import { start } from "../../../../agboss/tests/flow/fixtures/paths.js";

/** One item of the batch. */
export class ReportItemDto {
  @Text({ prompt: "the item" })
  title!: string;
}

/** What the item's workflow gives back. */
export class ItemReportDto {
  @Text({ prompt: "the item's report" })
  summary!: string;
}

/** What the batch gives back. */
export class BatchReportDto {
  @Text({ prompt: "the batch's report" })
  summary!: string;
}

@WorkflowStart({ name: "item-report-workflow-start", description: "One item", input: ReportItemDto })
export class ItemReportWorkflowStart {}

@Agent({
  name: "item-reporter-agent",
  description: "Reports on one item",
  prompt: "Report on the item.",
  model: "test/item-reporter",
  input: { item: ReportItemDto },
  output: ItemReportDto,
})
export class ItemReporterAgent {}

@WorkflowFinish({
  name: "item-report-workflow-finish",
  description: "The item's report",
  output: ItemReportDto,
})
export class ItemReportWorkflowFinish {}

@Workflow({
  name: "item-report-workflow",
  version: "1.0.0",
  flow: [
    start(ItemReportWorkflowStart)
      .returns(ReportItemDto)
      .toAgent(ItemReporterAgent)
      .returns(ItemReportDto)
      .toFinish(ItemReportWorkflowFinish),
  ],
})
export class ItemReportWorkflow {}

@WorkflowStart({
  name: "batch-report-workflow-start",
  description: "A batch of items",
  input: listOf(ReportItemDto),
})
export class BatchReportWorkflowStart {}

@Action({
  name: "pick-items-action",
  description: "The items to report on",
  input: { items: listOf(ReportItemDto) },
  output: listOf(ReportItemDto),
})
export class PickItemsAction {
  execute(input: { readonly items: readonly ReportItemDto[] }): Promise<readonly ReportItemDto[]> {
    return Promise.resolve(input.items);
  }
}

@Agent({
  name: "batch-reporter-agent",
  description: "Sums the item reports up",
  prompt: "Sum the reports up.",
  model: "test/batch-reporter",
  input: { reports: listOf(ItemReportDto) },
  output: BatchReportDto,
})
export class BatchReporterAgent {}

@WorkflowFinish({
  name: "batch-report-workflow-finish",
  description: "The batch's report",
  output: BatchReportDto,
})
export class BatchReportWorkflowFinish {}

@Workflow({
  name: "batch-report-workflow",
  version: "1.0.0",
  flow: [
    start(BatchReportWorkflowStart)
      .returns(listOf(ReportItemDto))
      .toAction(PickItemsAction)
      .returns(listOf(ReportItemDto))
      .toParallelWorkflows(ItemReportWorkflow, { maxConcurrency: 4, maxItems: 50 })
      .join()
      .returns(listOf(ItemReportDto))
      .toAgent(BatchReporterAgent)
      .returns(BatchReportDto)
      .toFinish(BatchReportWorkflowFinish),
  ],
})
export class BatchReportWorkflow {}

/** Why the report must not ask a budget for its amount. */
const notAsked = (budget: string): never => {
  throw new Error(`${budget}.maxSpend() was called — the report reads the decorators only`);
};

@Budget({
  name: "report-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class ReportApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return notAsked("report-application-budget");
  }
}

@Budget({ name: "report-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class ReportTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return notAsked("report-tenant-budget");
  }
}

@Budget({ name: "report-execution-budget", scope: BudgetScope.Execution })
export class ReportExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return notAsked("report-execution-budget");
  }
}

/** The application `agboss --application` loads (#268): the batch and, through it, its child. */
@Application({
  name: "report-application",
  version: "2.0.0",
  environment: EmptyEnvironment,
  workflows: [BatchReportWorkflow],
  budgets: [ReportApplicationBudget, ReportTenantBudget, ReportExecutionBudget],
})
export class ReportApplication {}
