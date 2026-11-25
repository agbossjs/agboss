import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { WorkflowStartTextDto } from "../../fixtures/dtos.js";
import { onAgent, onStart, toAgent, toFinish } from "../../../helpers/flow.js";
import { ItemDto, ItemResultDto } from "./fan-out.workflow.js";
import { ItemCheckWorkflow, ShopExecutionContext, ShopTenantContext } from "./children.workflow.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #263 / #271 AC12 — a child in a loop: the picker gives an item, the child checks it, a code router
 * sends a "retry" result back to the picker. The second item renews the first, and the child's
 * result built from it is outdated; the second child is a new execution in a new task namespace.
 */

@WorkflowStart({
  name: "pick-loop-workflow-start",
  description: "What to pick",
  input: WorkflowStartTextDto,
})
export class PickLoopWorkflowStart {}

@Agent({
  name: "item-picker-agent",
  description: "Picks an item",
  prompt: inline("Pick an item."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 2 },
  input: { message: WorkflowStartTextDto },
  output: ItemDto,
})
export class ItemPickerAgent {}

@WorkflowFinish({
  name: "picked-workflow-finish",
  description: "The item, checked",
  output: ItemResultDto,
})
export class PickedWorkflowFinish {}

@Router({
  name: "pick-again-router",
  description: "Picks again after a retry",
  decidedBy: DecidedBy.Code,
  maxVisits: 2,
  input: { result: ItemResultDto },
  routes: [ItemPickerAgent, PickedWorkflowFinish],
})
export class PickAgainRouter {
  route(input: { readonly result: Tracked<ItemResultDto> }): unknown {
    return input.result.name === "retry" ? ItemPickerAgent : PickedWorkflowFinish;
  }
}

@Workflow({
  name: "pick-loop-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PickLoopWorkflowStart)
      .toAgent(ItemPickerAgent),
    onAgent(ItemPickerAgent)
      .toWorkflow(ItemCheckWorkflow)
      .toRouter(PickAgainRouter)
      .onRoute(toAgent(ItemPickerAgent))
      .onRoute(toFinish(PickedWorkflowFinish)),
  ],
})
export class PickLoopWorkflow {}

@Application({
  name: "pick-loop-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  tenantContext: ShopTenantContext,
  executionContext: ShopExecutionContext,
  workflows: [PickLoopWorkflow],
  budgets: TEST_BUDGETS,
})
export class PickLoopApplication {}
