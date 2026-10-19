import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { WorkflowStartTextDto } from "../../fixtures/dtos.js";
import { agent, route, start } from "../../../helpers/flow.js";
import { ItemDto, ItemResultDto } from "./fan-out.workflow.js";
import { ItemCheckWorkflow, ShopExecutionContext, ShopTenantContext } from "./children.workflow.js";

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
  prompt: "Pick an item.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 2,
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
  routes: [{ target: ItemPickerAgent }, { target: PickedWorkflowFinish }],
})
export class PickAgainRouter {
  route(input: { readonly result: Produced<ItemResultDto, unknown> }): unknown {
    return input.result.value.name === "retry" ? ItemPickerAgent : PickedWorkflowFinish;
  }
}

@Workflow({
  name: "pick-loop-workflow",
  version: "1.0.0",
  flow: [
    start(PickLoopWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ItemPickerAgent),
    agent(ItemPickerAgent)
      .returns(ItemDto)
      .toWorkflow(ItemCheckWorkflow)
      .returns(ItemResultDto)
      .toRouter(PickAgainRouter)
      .chooseOne(route(ItemPickerAgent), route(PickedWorkflowFinish)),
  ],
})
export class PickLoopWorkflow {}

@Application({
  name: "pick-loop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  tenantContext: ShopTenantContext,
  executionContext: ShopExecutionContext,
  workflows: [PickLoopWorkflow],
  budgets: TEST_BUDGETS,
})
export class PickLoopApplication {}
