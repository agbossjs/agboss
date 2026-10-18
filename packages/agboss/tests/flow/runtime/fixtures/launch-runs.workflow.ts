import { TerminalUserChannel } from "../../../../src/channels/terminal-channel.js";
import { Text } from "../../../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  listOf,
  Router,
  Tool,
  VisitsLimitExceededError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
  type ToolHandler,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { WorkflowStartTextDto } from "../../fixtures/dtos.js";
import { CritiqueDto, PlanDto } from "../../fixtures/review-dtos.js";
import { agent, route, start, toFinish } from "../../../helpers/flow.js";
import {
  ItemDto,
  ItemResultDto,
  ItemsFailedWorkflowFinish,
  ItemsWorkflowStart,
  SummaryDto,
  SummaryWorkflowFinish,
} from "./fan-out.workflow.js";

/**
 * #273 PR 2 — launches over time: one inside a loop (each pass its own launch id and records), a
 * per-item agent that pauses for an approval in one branch (the others go on), and a per-item agent
 * whose `maxVisits` a launch passes (the limit fails the launch into `.onJoinError(…)`).
 */

// ── a launch inside a loop ──

@WorkflowStart({ name: "plan-loop-workflow-start", description: "A topic", input: WorkflowStartTextDto })
export class PlanLoopWorkflowStart {}

@Agent({
  name: "loop-planner-agent",
  description: "Plans",
  prompt: "Plan.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 2,
  input: { message: WorkflowStartTextDto },
  output: PlanDto,
})
export class LoopPlannerAgent {}

@Agent({
  name: "loop-critic-agent",
  description: "Criticises the plan",
  prompt: "Criticise.",
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: CritiqueDto,
})
export class LoopCriticAgent {}

@WorkflowFinish({
  name: "critiques-workflow-finish",
  description: "The last critiques",
  input: { critiques: listOf(CritiqueDto) },
  output: SummaryDto,
})
export class CritiquesWorkflowFinish {
  finish(input: { readonly critiques: readonly Produced<CritiqueDto, unknown>[] }): SummaryDto {
    const remarks = input.critiques.map((critique) => critique.value.remark);
    return { text: remarks.join(", ") };
  }
}

/** Plans again while a critique says "redo". */
@Router({
  name: "plan-loop-router",
  description: "Plans again or finishes",
  decidedBy: DecidedBy.Code,
  maxVisits: 2,
  input: { critiques: listOf(CritiqueDto) },
  routes: [{ target: LoopPlannerAgent }, { target: CritiquesWorkflowFinish }],
})
export class PlanLoopRouter {
  route(input: { readonly critiques: readonly Produced<CritiqueDto, unknown>[] }): unknown {
    const redo = input.critiques.some((critique) => critique.value.remark === "redo");
    return redo ? LoopPlannerAgent : CritiquesWorkflowFinish;
  }
}

@Workflow({
  name: "plan-loop-workflow",
  version: "1.0.0",
  flow: [
    start(PlanLoopWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(LoopPlannerAgent),
    agent(LoopPlannerAgent)
      .returns(PlanDto)
      .toParallelAgents(LoopCriticAgent, LoopCriticAgent)
      .join()
      .returns(listOf(CritiqueDto))
      .toRouter(PlanLoopRouter)
      .chooseOne(route(LoopPlannerAgent), route(CritiquesWorkflowFinish)),
  ],
})
export class PlanLoopWorkflow {}

@Application({
  name: "plan-loop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PlanLoopWorkflow],
  budgets: TEST_BUDGETS,
})
export class PlanLoopApplication {}

// ── a branch that pauses ──

export class ItemConfirmation {
  @Text({ prompt: "the item to confirm" })
  name!: string;
}

/** Every call waits for an approval. */
@Tool({
  name: "confirm_item",
  description: "Confirms an item",
  channel: TerminalUserChannel,
  input: ItemConfirmation,
  output: ItemConfirmation,
})
export class ConfirmItemTool implements ToolHandler<ItemConfirmation, ItemConfirmation> {
  run(input: ItemConfirmation): Promise<ItemConfirmation> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "item-clerk-agent",
  description: "Handles one item",
  prompt: "Handle the item.",
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmItemTool],
  input: { item: ItemDto },
  output: ItemResultDto,
})
export class ItemClerkAgent {}

@Workflow({
  name: "clerk-workflow",
  version: "1.0.0",
  maxSteps: 20,
  channelClasses: [TerminalUserChannel],
  flow: [
    start(ItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelAgents(ItemClerkAgent, { maxConcurrency: 2, maxItems: 10 })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class ClerkWorkflow {}

@Application({
  name: "clerk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClerkWorkflow],
  budgets: TEST_BUDGETS,
})
export class ClerkApplication {}

// ── a branch past its node's maxVisits ──

@Agent({
  name: "tired-clerk-agent",
  description: "Handles one item, twice per execution at most",
  prompt: "Handle the item.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 2,
  input: { item: ItemDto },
  output: ItemResultDto,
})
export class TiredClerkAgent {}

@Workflow({
  name: "tired-workflow",
  version: "1.0.0",
  flow: [
    start(ItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelAgents(TiredClerkAgent, { maxItems: 10 })
      .join()
      .onJoinError(VisitsLimitExceededError, toFinish(ItemsFailedWorkflowFinish))
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class TiredWorkflow {}

@Application({
  name: "tired-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TiredWorkflow],
  budgets: TEST_BUDGETS,
})
export class TiredApplication {}
