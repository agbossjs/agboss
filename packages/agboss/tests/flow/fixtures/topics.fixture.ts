import { onStart, toAgent } from "../../../src/flow/builder.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, Route } from "../../../src/flow/generated-types.js";
import type { RouterHandler } from "../../../src/flow/handlers.js";
import { SupportIntentDto, TopicAnswerDto } from "./credit-dtos.js";
import { inline } from "../../../src/index.js";

/** #280 — a code router with flat routes, continued with one `.onRoute(…)` per route. */

@WorkflowStart({
  name: "topics-workflow-start",
  description: "What the customer's message is about",
  input: SupportIntentDto,
})
export class TopicsWorkflowStart {}

@Agent({
  name: "order-topic-agent",
  description: "Answers about the order itself",
  prompt: inline("Answer about the order."),
  model: "moonshotai/kimi-k2.6",
  input: {
    intent: SupportIntentDto,
  },
  output: TopicAnswerDto,
})
export class OrderTopicAgent {}

@Agent({
  name: "refund-topic-agent",
  description: "Answers about refunds",
  prompt: inline("Answer about refunds."),
  model: "moonshotai/kimi-k2.6",
  input: {
    intent: SupportIntentDto,
  },
  output: TopicAnswerDto,
})
export class RefundTopicAgent {}

@Agent({
  name: "delivery-topic-agent",
  description: "Answers about the delivery",
  prompt: inline("Answer about the delivery."),
  model: "moonshotai/kimi-k2.6",
  input: {
    intent: SupportIntentDto,
  },
  output: TopicAnswerDto,
})
export class DeliveryTopicAgent {}

@WorkflowFinish({
  name: "topics-workflow-finish",
  description: "The answer",
  output: TopicAnswerDto,
})
export class TopicsWorkflowFinish {}

@Router({
  name: "topics-router",
  description: "Picks the agents the customer's message needs",
  decidedBy: DecidedBy.Code,
  input: {
    intent: SupportIntentDto,
  },
  routes: [OrderTopicAgent, RefundTopicAgent, DeliveryTopicAgent],
})
export class TopicsRouter implements RouterHandler<TopicsRouter> {
  route(input: InputOf<TopicsRouter>): Route<TopicsRouter> {
    return input.intent.value.isRefund ? RefundTopicAgent : DeliveryTopicAgent;
  }
}

@Workflow({
  name: "topics-workflow",
  version: "1.0.0",
  flow: [
    onStart(TopicsWorkflowStart)
      .toRouter(TopicsRouter)
      .onRoute(
        toAgent(OrderTopicAgent)
          .toFinish(TopicsWorkflowFinish),
      )
      .onRoute(
        toAgent(RefundTopicAgent)
          .toFinish(TopicsWorkflowFinish),
      )
      .onRoute(
        toAgent(DeliveryTopicAgent)
          .toFinish(TopicsWorkflowFinish),
      ),
  ],
})
export class TopicsWorkflow {}
