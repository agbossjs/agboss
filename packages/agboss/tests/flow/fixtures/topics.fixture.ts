import { route, start } from "../../../src/flow/builder.js";
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
import type { InputOf, Route } from "../../../src/flow/generated-types.js";
import type { RouterHandler } from "../../../src/flow/handlers.js";
import { SupportIntentDto, TopicAnswerDto } from "./credit-dtos.js";

/**
 * #280 — a code router with `spawn` / `failure` on its routes, the options of a parallel launch
 * (#273). Until `.toParallelAgents(…)` exists every flow continues a router with `.chooseOne(…)`, so
 * this workflow fails assembly with `[router.policy-with-choose-one]`; its types are still written
 * (after `.chooseOne(…)` `Route<TopicsRouter>` is every target — spawn policies apply to launches).
 */

@WorkflowStart({
  name: "topics-workflow-start",
  description: "What the customer's message is about",
  input: SupportIntentDto,
})
export class TopicsWorkflowStart {}

@Agent({
  name: "order-topic-agent",
  description: "Answers about the order itself",
  prompt: "Answer about the order.",
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
  prompt: "Answer about refunds.",
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
  prompt: "Answer about the delivery.",
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
  routes: [
    { target: OrderTopicAgent, spawn: SpawnPolicy.Always }, // launched by the framework
    { target: RefundTopicAgent, failure: FailurePolicy.Skip },
    { target: DeliveryTopicAgent },
  ],
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
    start(TopicsWorkflowStart)
      .returns(SupportIntentDto)
      .toRouter(TopicsRouter)
      .chooseOne(
        route(OrderTopicAgent)
          .returns(TopicAnswerDto)
          .toFinish(TopicsWorkflowFinish),
        route(RefundTopicAgent)
          .returns(TopicAnswerDto)
          .toFinish(TopicsWorkflowFinish),
        route(DeliveryTopicAgent)
          .returns(TopicAnswerDto)
          .toFinish(TopicsWorkflowFinish),
      ),
  ],
})
export class TopicsWorkflow {}
