import { onAction, onStart, toFinish, Workflow, toAgent, toAction, Ttl } from "@agboss/core";
import { ChargeCardAction } from "../../actions/charge-card.action.js";
import { ApprovalAgent } from "../../agents/approval/approval.agent.js";
import { OrderIntakeAgent } from "../../agents/order-intake/order-intake.agent.js";
import { CreditLimitRouter } from "../../routers/credit-limit/credit-limit.router.js";
import { DeskRouter } from "../../routers/desk/desk.router.js";
import { CreditServiceUnavailableError } from "../../errors/credit-service-unavailable.error.js";
import { CreditService } from "../../services/credit.service.js";
import { CreditWorkflowFinish } from "./credit.workflow-finish.js";
import { NoOrderWorkflowFinish } from "./no-order.workflow-finish.js";
import { OrderHeldWorkflowFinish } from "./order-held.workflow-finish.js";
import { CreditWorkflowStart } from "./credit.workflow-start.js";

/**
 * A code router inside a model router's route (#280): the desk router (Jev) sends an order to the
 * intake, the credit-limit router's `route()` sends it for approval or straight to the charge. A
 * credit service that is down (`CreditServiceUnavailableError`, the `StepError.Router`'s cause)
 * holds the order; any other error fails the run. The charge is a side effect made once per
 * step: `ChargeCardAction` writes it as a fenced effect (#500) on the application's SQLite file.
 */
@Workflow({
  name: "credit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(CreditWorkflowStart)
      .toRouter(DeskRouter)
      .onRoute(
        toAgent(OrderIntakeAgent)
          .toRouter(CreditLimitRouter)
          .onError(CreditServiceUnavailableError, toFinish(OrderHeldWorkflowFinish))
          .onRoute(
            toAgent(ApprovalAgent)
              .toAction(ChargeCardAction),
          )
          .onRoute(toAction(ChargeCardAction)),
      )
      .onRoute(toFinish(NoOrderWorkflowFinish)),

    // two ways in (ApprovalAgent, CreditLimitRouter): the charge's path is its own
    onAction(ChargeCardAction)
      .toFinish(CreditWorkflowFinish),
  ],
  executionLimits: { maxSteps: 8 },
  providers: [CreditService],
})
export class CreditWorkflow {}
