// `agboss studio` fixture (#268 AC7): a child launched once and once per item, and a workflow
// launching itself — the shapes Studio must draw inside their parent; every step an action
import {
  Action,
  Application,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Ttl,
} from "../../../../../agboss/src/index.js";
import { Text } from "../../../../../agboss/src/dto/index.js";
import { listOf } from "../../../../../agboss/src/flow/dto-wrappers.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { SplitWorkflow } from "../../../../../agboss/tests/flow/runtime/fixtures/recursion.workflow.js";
import { onStart, toWorkflow } from "../../../../../agboss/tests/helpers/flow.js";
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
  execute(input: { readonly item: StudioItemDto }): Promise<StudioResultDto> {
    return Promise.resolve({ name: input.item.name });
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(StudioItemWorkflowStart).toAction(CheckItemAction).toFinish(ItemCheckedWorkflowFinish),
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
  execute(input: { readonly results: readonly StudioResultDto[] }): Promise<StudioSummaryDto> {
    return Promise.resolve({
      text: input.results.map((result) => result.name).join(", "),
    });
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(StudioItemsWorkflowStart)
      .forEachItem(toWorkflow(StudioItemWorkflow), { takeFirst: 10, maxConcurrency: 2 })
      .join()
      .toAction(SummaryAction)
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(StudioOneWorkflowStart)
      .toWorkflow(StudioItemWorkflow)
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
