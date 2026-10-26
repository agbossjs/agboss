import { Agent } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { CreditOrderDto } from "../dtos/credit-order.dto.js";

/** Reads the order — who orders and for how much — from the customer's message. */
@Agent({
  name: "order-intake-agent",
  description: "Reads the order from the message",
  promptUrls: ["./order-intake.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: CreditOrderDto,
})
export class OrderIntakeAgent {}
