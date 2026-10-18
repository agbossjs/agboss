import { start, toAction } from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import {
  DecidedBy,
  FailurePolicy,
  Router,
  SpawnPolicy,
} from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf, RouterAnswerOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler, RouterHandler } from "../../../src/flow/handlers.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { CompanyDto, CustomerReplyDto, LoyaltyOfferDto, OrderStatusDto } from "./data-dtos.js";
import {
  ArticleDraftDto,
  CompanyCheckDto,
  PaymentDto,
  RankingDto,
  RefundPolicyDto,
  ScreeningFailedDto,
} from "./launch-dtos.js";
import { CritiqueDto, PlanDto, ResearchDto } from "./review-dtos.js";

/**
 * #273 — the issue's four launches, each a workflow of its own: different agents (a repeated one),
 * one agent per item of a list, parallel actions without output, and a model router deciding who
 * is launched; plus a code router's launch. They pass the analyser; their runtime is #273 PR 2.
 */

// ── different agents, wait for all ──

@WorkflowStart({
  name: "research-workflow-start",
  description: "What to write about",
  input: WorkflowStartTextDto,
})
export class ResearchWorkflowStart {}

@Agent({
  name: "planner-agent",
  description: "Plans the article",
  prompt: "Plan the article.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: PlanDto,
})
export class PlannerAgent {}

@Agent({
  name: "plan-researcher-agent",
  description: "Researches the plan",
  prompt: "Research the plan.",
  model: "moonshotai/kimi-k2.6",
  input: {
    plan: PlanDto,
  },
  output: ResearchDto,
})
export class PlanResearcherAgent {}

@Agent({
  name: "critic-agent",
  description: "Criticises the plan",
  prompt: "Criticise the plan.",
  model: "moonshotai/kimi-k2.6",
  input: {
    plan: PlanDto,
  },
  output: CritiqueDto,
})
export class CriticAgent {}

@Agent({
  name: "article-writer-agent",
  description: "Writes the article from the plan, the research and the critiques",
  prompt: "Write the article.",
  model: "moonshotai/kimi-k2.6",
  input: {
    plan: PlanDto,
    research: ResearchDto,
    critiques: listOf(CritiqueDto), // the two CriticAgent copies
  },
  output: ArticleDraftDto,
})
export class ArticleWriterAgent {}

@WorkflowFinish({
  name: "article-draft-workflow-finish",
  description: "The article",
  output: ArticleDraftDto,
})
export class ArticleDraftWorkflowFinish {}

@Workflow({
  name: "research-workflow",
  version: "1.0.0",
  flow: [
    start(ResearchWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(PlannerAgent)
      .returns(PlanDto)
      .toParallelAgents(PlanResearcherAgent, CriticAgent, CriticAgent, { maxConcurrency: 3 })
      .join()
      .returns(ResearchDto)
      .returns(listOf(CritiqueDto))
      .toAgent(ArticleWriterAgent)
      .returns(ArticleDraftDto)
      .toFinish(ArticleDraftWorkflowFinish),
  ],
})
export class ResearchWorkflow {}

// ── one agent per item of a list ──

@WorkflowStart({
  name: "screening-workflow-start",
  description: "Which companies to look for",
  input: WorkflowStartTextDto,
})
export class ScreeningWorkflowStart {}

@Agent({
  name: "screening-agent",
  description: "Finds the companies",
  prompt: "Find the companies.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: listOf(CompanyDto),
})
export class ScreeningAgent {}

@Agent({
  name: "company-audit-agent",
  description: "Checks one company",
  prompt: "Check the company.",
  model: "moonshotai/kimi-k2.6",
  input: {
    company: CompanyDto, // the item of this run
  },
  output: CompanyCheckDto,
})
export class CompanyAuditAgent {}

@Agent({
  name: "ranker-agent",
  description: "Ranks the checked companies",
  prompt: "Rank the companies.",
  model: "moonshotai/kimi-k2.6",
  input: {
    checks: listOf(CompanyCheckDto), // one per item
  },
  output: RankingDto,
})
export class RankerAgent {}

@Action({
  name: "notify-operator-action",
  description: "Tells the operator the screening stopped",
  input: {
    companies: listOf(CompanyDto),
  },
  output: ScreeningFailedDto,
})
export class NotifyOperatorAction implements ActionHandler<NotifyOperatorAction> {
  execute(input: InputOf<NotifyOperatorAction>): Promise<OutputOf<NotifyOperatorAction>> {
    return Promise.resolve({ reason: `stopped after ${String(input.companies.length)} companies` });
  }
}

@WorkflowFinish({
  name: "ranking-workflow-finish",
  description: "The ranking",
  output: RankingDto,
})
export class RankingWorkflowFinish {}

@WorkflowFinish({
  name: "screening-failed-workflow-finish",
  description: "Why the screening stopped",
  output: ScreeningFailedDto,
})
export class ScreeningFailedWorkflowFinish {}

@Workflow({
  name: "screening-workflow",
  version: "1.0.0",
  flow: [
    start(ScreeningWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ScreeningAgent)
      .returns(listOf(CompanyDto))
      .toParallelAgents(CompanyAuditAgent, { maxConcurrency: 3, maxItems: 50 })
      .join()
      .onJoinError(
        LimitExceededError,
        toAction(NotifyOperatorAction)
          .returns(ScreeningFailedDto)
          .toFinish(ScreeningFailedWorkflowFinish),
      )
      .returns(listOf(CompanyCheckDto))
      .toAgent(RankerAgent)
      .returns(RankingDto)
      .toFinish(RankingWorkflowFinish),
  ],
})
export class ScreeningWorkflow {}

// ── parallel actions without output ──

@WorkflowStart({
  name: "checkout-workflow-start",
  description: "The order to pay",
  input: WorkflowStartTextDto,
})
export class CheckoutWorkflowStart {}

@Action({
  name: "charge-payment-action",
  description: "Charges the order",
  input: {
    message: WorkflowStartTextDto,
  },
  output: PaymentDto,
})
export class ChargePaymentAction implements ActionHandler<ChargePaymentAction> {
  execute(input: InputOf<ChargePaymentAction>): Promise<OutputOf<ChargePaymentAction>> {
    return Promise.resolve({ paymentId: input.message.value.text, amount: 1 });
  }
}

@Action({
  name: "send-receipt-action",
  description: "Sends the receipt",
  input: {
    payment: PaymentDto,
  },
})
export class SendReceiptAction implements ActionHandler<SendReceiptAction> {
  async execute(input: InputOf<SendReceiptAction>): Promise<void> {
    await Promise.resolve(input.payment.value.paymentId);
  }
}

@Action({
  name: "update-crm-action",
  description: "Records the payment in the CRM",
  input: {
    payment: PaymentDto,
  },
})
export class UpdateCrmAction implements ActionHandler<UpdateCrmAction> {
  async execute(input: InputOf<UpdateCrmAction>): Promise<void> {
    await Promise.resolve(input.payment.value.paymentId);
  }
}

@Action({
  name: "reserve-goods-action",
  description: "Reserves the goods",
  input: {
    payment: PaymentDto,
  },
})
export class ReserveGoodsAction implements ActionHandler<ReserveGoodsAction> {
  async execute(input: InputOf<ReserveGoodsAction>): Promise<void> {
    await Promise.resolve(input.payment.value.paymentId);
  }
}

@WorkflowFinish({
  name: "payment-workflow-finish",
  description: "The payment",
  output: PaymentDto,
})
export class PaymentWorkflowFinish {}

@Workflow({
  name: "checkout-workflow",
  version: "1.0.0",
  flow: [
    start(CheckoutWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChargePaymentAction)
      .returns(PaymentDto)
      .toParallelActions(SendReceiptAction, UpdateCrmAction, ReserveGoodsAction, {
        maxConcurrency: 3,
      })
      .join() // three side effects without output: nothing to name
      .toFinish(PaymentWorkflowFinish), // reads PaymentDto from the path
  ],
})
export class CheckoutWorkflow {}

// ── a model router decides who is launched; the policies are in its routes ──

@WorkflowStart({
  name: "help-desk-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class HelpDeskWorkflowStart {}

@Agent({
  name: "order-lookup-agent",
  description: "Looks the order up",
  prompt: "Look the order up.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: OrderStatusDto,
})
export class OrderLookupAgent {}

@Agent({
  name: "refund-policy-agent",
  description: "Reads the refund policy",
  prompt: "Quote the refund policy.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: RefundPolicyDto,
})
export class RefundPolicyAgent {}

@Agent({
  name: "loyalty-offer-agent",
  description: "Finds an offer for the customer",
  prompt: "Find an offer.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: LoyaltyOfferDto,
})
export class LoyaltyOfferAgent {}

@Router({
  name: "help-desk-router",
  description: "Picks everyone needed for the customer's message",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick everyone needed for the customer's message.",
  input: {
    message: WorkflowStartTextDto,
  },
  routes: [
    { target: OrderLookupAgent, spawn: SpawnPolicy.Always },
    {
      target: RefundPolicyAgent,
      spawn: SpawnPolicy.OnDemand,
      prompt: "The message is about returns",
    },
    { target: LoyaltyOfferAgent, spawn: SpawnPolicy.Always, failure: FailurePolicy.Skip },
  ],
})
export class HelpDeskRouter {}

@Agent({
  name: "answer-agent",
  description: "Writes the reply from the branches' results",
  prompt: "Write the reply.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
    order: OrderStatusDto,
    refund: optional(RefundPolicyDto), // OnDemand — may not launch
    loyalty: optional(LoyaltyOfferDto), // Skip — may drop out
  },
  output: CustomerReplyDto,
})
export class AnswerAgent {}

@WorkflowFinish({
  name: "help-desk-workflow-finish",
  description: "The reply",
  output: CustomerReplyDto,
})
export class HelpDeskWorkflowFinish {}

@Workflow({
  name: "help-desk-workflow",
  version: "1.0.0",
  flow: [
    start(HelpDeskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(HelpDeskRouter)
      .toParallelAgents(OrderLookupAgent, RefundPolicyAgent, LoyaltyOfferAgent)
      .join()
      .returns(OrderStatusDto)
      .returns(optional(RefundPolicyDto))
      .returns(optional(LoyaltyOfferDto))
      .toAgent(AnswerAgent)
      .returns(CustomerReplyDto)
      .toFinish(HelpDeskWorkflowFinish),
  ],
})
export class HelpDeskWorkflow {}

// ── a code router: route() returns the OnDemand agents to launch ──

@WorkflowStart({
  name: "offers-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class OffersWorkflowStart {}

@Router({
  name: "offers-router",
  description: "Adds an offer when the customer is loyal",
  decidedBy: DecidedBy.Code,
  input: {
    message: WorkflowStartTextDto,
  },
  routes: [{ target: RefundPolicyAgent, spawn: SpawnPolicy.Always }, { target: LoyaltyOfferAgent }],
})
export class OffersRouter implements RouterHandler<OffersRouter> {
  route(input: InputOf<OffersRouter>): RouterAnswerOf<OffersRouter> {
    return input.message.value.text.includes("loyal") ? [LoyaltyOfferAgent] : [];
  }
}

@Agent({
  name: "offers-answer-agent",
  description: "Answers with the policy and maybe an offer",
  prompt: "Answer.",
  model: "moonshotai/kimi-k2.6",
  input: {
    refund: RefundPolicyDto,
    loyalty: optional(LoyaltyOfferDto),
  },
  output: CustomerReplyDto,
})
export class OffersAnswerAgent {}

@WorkflowFinish({
  name: "offers-workflow-finish",
  description: "The reply",
  output: CustomerReplyDto,
})
export class OffersWorkflowFinish {}

@Workflow({
  name: "offers-workflow",
  version: "1.0.0",
  flow: [
    start(OffersWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(OffersRouter)
      .toParallelAgents(RefundPolicyAgent, LoyaltyOfferAgent)
      .join()
      .returns(RefundPolicyDto)
      .returns(optional(LoyaltyOfferDto))
      .toAgent(OffersAnswerAgent)
      .returns(CustomerReplyDto)
      .toFinish(OffersWorkflowFinish),
  ],
})
export class OffersWorkflow {}
