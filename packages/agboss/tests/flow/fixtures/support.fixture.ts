import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import {
  CustomerReplyDto,
  ExpertDraftDto,
  FastDraftDto,
  LoyaltyOfferDto,
  OrderStatusDto,
} from "./data-dtos.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { agent, route, start } from "./paths.js";

/** #270 — the support desk: a router, an optional loyalty offer, a finish reading `fast` or `expert`. */

@WorkflowStart({
  name: "support-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class SupportWorkflowStart {}

@Agent({
  name: "order-agent",
  description: "Looks the customer's order up",
  prompt: "Look the order up.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: OrderStatusDto,
})
export class OrderAgent {}

@Agent({
  name: "fast-answer-agent",
  description: "Writes a quick reply",
  prompt: "Reply quickly.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
    order: OrderStatusDto,
  },
  output: FastDraftDto,
})
export class FastAnswerAgent {}

@Agent({
  name: "loyalty-agent",
  description: "Finds an offer for a loyal customer",
  prompt: "Find an offer.",
  model: "moonshotai/kimi-k2.6",
  input: {
    order: OrderStatusDto,
  },
  output: LoyaltyOfferDto,
})
export class LoyaltyAgent {}

@Agent({
  name: "expert-answer-agent",
  description: "Writes a careful reply",
  prompt: "Reply carefully.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
    order: OrderStatusDto,
    loyalty: optional(LoyaltyOfferDto),
  },
  output: ExpertDraftDto,
})
export class ExpertAnswerAgent {}

@WorkflowFinish({
  name: "support-workflow-finish",
  description: "The reply to the customer",
  input: {
    fast: optional(FastDraftDto),
    expert: optional(ExpertDraftDto),
  },
  output: CustomerReplyDto,
})
export class SupportWorkflowFinish {
  finish(): CustomerReplyDto {
    return { text: "", holdForReview: false };
  }
}

@Router({
  name: "answer-router",
  description: "Picks how to answer",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  input: {
    order: OrderStatusDto,
  },
  routes: [
    { target: FastAnswerAgent, prompt: "A simple question" },
    { target: LoyaltyAgent, prompt: "A loyal customer with a problem" },
    { target: ExpertAnswerAgent, prompt: "A hard question" },
  ],
})
export class AnswerRouter {}

export const supportPaths = [
  start(SupportWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(OrderAgent)
    .returns(OrderStatusDto)
    .toRouter(AnswerRouter)
    .chooseOne(
      route(FastAnswerAgent).returns(FastDraftDto).toFinish(SupportWorkflowFinish),
      route(LoyaltyAgent).returns(LoyaltyOfferDto).toAgent(ExpertAnswerAgent),
      route(ExpertAnswerAgent),
    ),
  agent(ExpertAnswerAgent).returns(ExpertDraftDto).toFinish(SupportWorkflowFinish),
];

@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  flow: supportPaths,
})
export class SupportWorkflow {}
