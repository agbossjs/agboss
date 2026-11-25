import { LimitError } from "../../../../src/core/error-families/limit-errors.js";
import { OwnerToolApproval } from "../../fixtures/owner-approval.fixture.js";
import { Text } from "../../../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  listOf,
  Router,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Action,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { WorkflowStartTextDto } from "../../fixtures/dtos.js";
import { CritiqueDto, PlanDto } from "../../fixtures/review-dtos.js";
import { onAgent, onStart, toFinish, toAgent, toAction } from "../../../helpers/flow.js";
import {
  ItemDto,
  ItemResultDto,
  ItemsWorkflowStart,
  SummaryDto,
  SummaryWorkflowFinish,
  SummaryAction,
} from "./fan-out.workflow.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #273 PR 2 — launches over time: one inside a loop (each pass its own launch id and records), a
 * per-item agent that pauses for an approval in one branch (the others go on), and a per-item agent
 * whose `maxVisits` a launch passes (the limit fails the launch into `.onError(…)`).
 */

// ── a launch inside a loop ──

@WorkflowStart({
  name: "plan-loop-workflow-start",
  description: "A topic",
  input: WorkflowStartTextDto,
})
export class PlanLoopWorkflowStart {}

@Agent({
  name: "loop-planner-agent",
  description: "Plans",
  prompt: inline("Plan."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 2 },
  input: { message: WorkflowStartTextDto },
  output: PlanDto,
})
export class LoopPlannerAgent {}

@Agent({
  name: "loop-critic-agent",
  description: "Criticises the plan",
  prompt: inline("Criticise."),
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: CritiqueDto,
})
export class LoopCriticAgent {}

@Action({
  name: "critiques-action",
  description: "The last critiques",
  input: { critiques: listOf(CritiqueDto) },
  output: SummaryDto,
})
export class CritiquesAction {
  async execute(input: {
    readonly critiques: readonly Tracked<CritiqueDto>[];
  }): Promise<SummaryDto> {
    const remarks = input.critiques.map((critique) => critique.remark);
    return { text: remarks.join(", ") };
  }
}

@WorkflowFinish({
  name: "critiques-workflow-finish",
  description: "The last critiques",
  output: SummaryDto,
})
export class CritiquesWorkflowFinish {}

/** Plans again while a critique says "redo". */
@Router({
  name: "plan-loop-router",
  description: "Plans again or finishes",
  decidedBy: DecidedBy.Code,
  maxVisits: 2,
  input: { critiques: listOf(CritiqueDto) },
  routes: [LoopPlannerAgent, CritiquesAction],
})
export class PlanLoopRouter {
  route(input: { readonly critiques: readonly Tracked<CritiqueDto>[] }): unknown {
    const redo = input.critiques.some((critique) => critique.remark === "redo");
    return redo ? LoopPlannerAgent : CritiquesAction;
  }
}

@Workflow({
  name: "plan-loop-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PlanLoopWorkflowStart).toAgent(LoopPlannerAgent),
    onAgent(LoopPlannerAgent)
      .inParallel([toAgent(LoopCriticAgent), toAgent(LoopCriticAgent)])
      .join()
      .toRouter(PlanLoopRouter)
      .onRoute(toAgent(LoopPlannerAgent))
      .onRoute(toAction(CritiquesAction).toFinish(CritiquesWorkflowFinish)),
  ],
})
export class PlanLoopWorkflow {}

@Application({
  name: "plan-loop-application",
  modelProvider: TestModelProvider,
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
  name: "confirm-item-tool",
  description: "Confirms an item",
  approval: OwnerToolApproval,
  input: ItemConfirmation,
  output: ItemConfirmation,
})
export class ConfirmItemTool {
  execute(input: ItemConfirmation): Promise<ItemConfirmation> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "item-clerk-agent",
  description: "Handles one item",
  prompt: inline("Handle the item."),
  model: "moonshotai/kimi-k2.6",
  tools: [ConfirmItemTool],
  input: { item: ItemDto },
  output: ItemResultDto,
})
export class ItemClerkAgent {}

@Workflow({
  name: "clerk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(ItemsWorkflowStart)
      .forEachItem(toAgent(ItemClerkAgent), { takeFirst: 10, maxConcurrency: 2 })
      .join()
      .toAction(SummaryAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class ClerkWorkflow {}

@Application({
  name: "clerk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClerkWorkflow],
  budgets: TEST_BUDGETS,
})
export class ClerkApplication {}

// ── a launch past its node's maxVisits ──

@WorkflowStart({
  name: "tired-workflow-start",
  description: "A topic",
  input: WorkflowStartTextDto,
})
export class TiredWorkflowStart {}

@Agent({
  name: "tired-planner-agent",
  description: "Plans",
  prompt: inline("Plan."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 2 },
  input: { message: WorkflowStartTextDto },
  output: PlanDto,
})
export class TiredPlannerAgent {}

/** Launched twice as copies per pass: one visit per launch, so its second launch passes maxVisits 1. */
@Agent({
  name: "tired-critic-agent",
  description: "Criticises the plan, once per execution",
  prompt: inline("Criticise."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 1 },
  input: { plan: PlanDto },
  output: CritiqueDto,
})
export class TiredCriticAgent {}

@WorkflowFinish({ name: "tired-workflow-finish", description: "The plan", output: PlanDto })
export class TiredWorkflowFinish {}

@Router({
  name: "tired-loop-router",
  description: "Plans again or finishes",
  decidedBy: DecidedBy.Code,
  maxVisits: 2,
  input: { critiques: listOf(CritiqueDto) },
  routes: [TiredPlannerAgent, CritiquesAction],
})
export class TiredLoopRouter {
  route(input: { readonly critiques: readonly Tracked<CritiqueDto>[] }): unknown {
    const redo = input.critiques.some((critique) => critique.remark === "redo");
    return redo ? TiredPlannerAgent : CritiquesAction;
  }
}

@Workflow({
  name: "tired-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TiredWorkflowStart).toAgent(TiredPlannerAgent),
    onAgent(TiredPlannerAgent)
      .inParallel([toAgent(TiredCriticAgent), toAgent(TiredCriticAgent)])
      .join()
      .onError(LimitError.Visits, toFinish(TiredWorkflowFinish))
      .toRouter(TiredLoopRouter)
      .onRoute(toAgent(TiredPlannerAgent))
      .onRoute(toAction(CritiquesAction).toFinish(CritiquesWorkflowFinish)),
  ],
})
export class TiredWorkflow {}

@Application({
  name: "tired-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TiredWorkflow],
  budgets: TEST_BUDGETS,
})
export class TiredApplication {}
