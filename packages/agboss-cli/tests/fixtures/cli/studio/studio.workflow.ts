// `agboss studio` fixture (#268 AC7): a child launched once and once per item, and a workflow
// launching itself — the shapes Studio must draw inside their parent; every step an action
import {
  Action,
  Application,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../../../agboss/src/index.js";
import { Text } from "../../../../../agboss/src/dto/index.js";
import { listOf } from "../../../../../agboss/src/flow/dto-wrappers.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { SplitWorkflow } from "../../../../../agboss/tests/flow/runtime/fixtures/recursion.workflow.js";
import { start } from "../../../../../agboss/tests/helpers/flow.js";
import { StudioEnvironment } from "./environments/app.environment.js";

export class StudioItemDto {
  @Text({ prompt: "the item" })
  name!: string;
}

export class StudioResultDto {
  @Text({ prompt: "the item, checked" })
  name!: string;
}

export class StudioSummaryDto {
  @Text({ prompt: "what was checked" })
  text!: string;
}

@WorkflowStart({
  name: "studio-item-workflow-start",
  description: "One item",
  input: StudioItemDto,
})
export class StudioItemWorkflowStart {}

@Action({
  name: "check-item-action",
  description: "Checks one item",
  input: { item: StudioItemDto },
  output: StudioResultDto,
})
export class CheckItemAction {
  execute(input: { readonly item: { readonly value: StudioItemDto } }): Promise<StudioResultDto> {
    return Promise.resolve({ name: input.item.value.name });
  }
}

@WorkflowFinish({
  name: "item-checked-workflow-finish",
  description: "The item, checked",
  output: StudioResultDto,
})
export class ItemCheckedWorkflowFinish {}

/** The child: one item, one action. */
@Workflow({
  name: "studio-item-workflow",
  version: "1.0.0",
  flow: [
    start(StudioItemWorkflowStart)
      .returns(StudioItemDto)
      .toAction(CheckItemAction)
      .returns(StudioResultDto)
      .toFinish(ItemCheckedWorkflowFinish),
  ],
})
export class StudioItemWorkflow {}

@WorkflowStart({
  name: "studio-items-workflow-start",
  description: "Items to check",
  input: listOf(StudioItemDto),
})
export class StudioItemsWorkflowStart {}

@Action({
  name: "summary-action",
  description: "Lists what was checked",
  input: { results: listOf(StudioResultDto) },
  output: StudioSummaryDto,
})
export class SummaryAction {
  execute(input: {
    readonly results: readonly { readonly value: StudioResultDto }[];
  }): Promise<StudioSummaryDto> {
    return Promise.resolve({ text: input.results.map((result) => result.value.name)
      .join(", ") });
  }
}

@WorkflowFinish({
  name: "summary-workflow-finish",
  description: "The summary",
  output: StudioSummaryDto,
})
export class SummaryWorkflowFinish {}

/** One child per item. */
@Workflow({
  name: "studio-items-workflow",
  version: "1.0.0",
  flow: [
    start(StudioItemsWorkflowStart)
      .returns(listOf(StudioItemDto))
      .toParallelWorkflows(StudioItemWorkflow, { maxConcurrency: 2, maxItems: 10 })
      .join()
      .returns(listOf(StudioResultDto))
      .toAction(SummaryAction)
      .returns(StudioSummaryDto)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class StudioItemsWorkflow {}

@WorkflowStart({ name: "studio-one-workflow-start", description: "One item", input: StudioItemDto })
export class StudioOneWorkflowStart {}

@WorkflowFinish({
  name: "one-checked-workflow-finish",
  description: "The item, checked by the child",
  output: StudioResultDto,
})
export class OneCheckedWorkflowFinish {}

/** One child, entered by an edge. */
@Workflow({
  name: "studio-one-workflow",
  version: "1.0.0",
  flow: [
    start(StudioOneWorkflowStart)
      .returns(StudioItemDto)
      .toWorkflow(StudioItemWorkflow)
      .returns(StudioResultDto)
      .toFinish(OneCheckedWorkflowFinish),
  ],
})
export class StudioOneWorkflow {}

/** The child is not listed: it belongs to its parents. */
@Application({
  name: "studio-application",
  version: "1.0.0",
  environment: StudioEnvironment,
  workflows: [StudioItemsWorkflow, StudioOneWorkflow, SplitWorkflow],
  budgets: TEST_BUDGETS,
})
export class StudioApplication {}
