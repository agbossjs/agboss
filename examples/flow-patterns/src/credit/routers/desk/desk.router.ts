import { DecidedBy, Router } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { OrderIntakeAgent } from "../../agents/order-intake/order-intake.agent.js";
import { NoOrderWorkflowFinish } from "../../workflows/credit/no-order.workflow-finish.js";

/** A router decided by a model (Jev), beside the code router in the same flow. */
@Router({
  name: "desk-router",
  description: "Sends an order to the intake, ends on anything else",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who handles the customer's message.",
  input: {
    message: WorkflowStartTextDto,
  },
  maxVisits: 1,
  routes: [
    { target: OrderIntakeAgent, prompt: "The customer wants to place an order" },
    { target: NoOrderWorkflowFinish, prompt: "Stop and hand the message over: it is not an order" },
  ],
})
export class DeskRouter {}
