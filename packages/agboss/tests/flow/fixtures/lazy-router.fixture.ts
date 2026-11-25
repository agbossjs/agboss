import { onStart, toAgent, toFinish } from "../../../src/flow/builder.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { Route } from "../../../src/flow/generated-types.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { ChargeResultDto } from "./credit-dtos.js";
import { inline, Ttl } from "../../../src/index.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #1271b — a router that names the finish and the agent declared BELOW it: the thunk `() => Target`
 * is read at assembly, once the module has run, where the class itself would be a `ReferenceError`
 * (the temporal dead zone). The same router with eager targets is `LazyDeskRouter`'s twin in the
 * test (`lazy-targets.test.ts`).
 */

@WorkflowStart({
  name: "lazy-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class LazyWorkflowStart {}

@Router({
  name: "lazy-desk-router",
  description: "Sends an order to the intake, ends on anything else",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  prompt: inline("Pick who handles the customer's message."),
  input: { message: WorkflowStartTextDto },
  routes: [
    { target: () => LazyIntakeAgent, prompt: "The customer wants to place an order" },
    { target: () => LazyNoOrderFinish, prompt: "Stop and hand the message over: not an order" },
  ],
})
export class LazyDeskRouter {}

@Agent({
  name: "lazy-intake-agent",
  description: "Takes the order",
  prompt: inline("Take the order."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: ChargeResultDto,
})
export class LazyIntakeAgent {}

@WorkflowFinish({
  name: "lazy-no-order-workflow-finish",
  description: "The message, not an order",
  output: WorkflowStartTextDto,
})
export class LazyNoOrderFinish {}

@WorkflowFinish({
  name: "lazy-order-workflow-finish",
  description: "The order, taken",
  output: ChargeResultDto,
})
export class LazyOrderFinish {}

/** What the router decides on, by its generated table: the same type with or without a thunk. */
export type LazyDeskRoute = Route<LazyDeskRouter>;

const desk = onStart(LazyWorkflowStart)
  .toRouter(LazyDeskRouter);

@Workflow({
  name: "lazy-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    desk
      .onRoute(
        toAgent(LazyIntakeAgent)
          .toFinish(LazyOrderFinish),
      )
      .onRoute(toFinish(LazyNoOrderFinish)),
  ],
})
export class LazyWorkflow {}
