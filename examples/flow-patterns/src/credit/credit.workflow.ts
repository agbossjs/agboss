import {
  action,
  route,
  start,
  toFinish,
  Workflow,
} from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { ChargeCardAction } from "./actions/charge-card.action.js";
import { ApprovalAgent } from "./agents/approval.agent.js";
import { OrderIntakeAgent } from "./agents/order-intake.agent.js";
import { ChargeResultDto } from "./dtos/charge-result.dto.js";
import { CreditApprovalDto } from "./dtos/credit-approval.dto.js";
import { CreditOrderDto } from "./dtos/credit-order.dto.js";
import { CreditLimitRouter } from "./routers/credit-limit.router.js";
import { DeskRouter } from "./routers/desk.router.js";
import { CreditServiceUnavailableError } from "./services/credit-service-unavailable.error.js";
import { CreditService } from "./services/credit.service.js";
import { CreditWorkflowFinish } from "./workflow-finishes/credit.workflow-finish.js";
import { NoOrderWorkflowFinish } from "./workflow-finishes/no-order.workflow-finish.js";
import { OrderHeldWorkflowFinish } from "./workflow-finishes/order-held.workflow-finish.js";
import { CreditWorkflowStart } from "./workflow-starts/credit.workflow-start.js";

/**
 * A code router inside a model router's route (#280): the desk router (Jev) sends an order to the
 * intake, the credit-limit router's `route()` sends it for approval or straight to the charge. A
 * credit service that is down (`CreditServiceUnavailableError`, the `RouterFailedError`'s cause)
 * holds the order; any other error fails the run.
 */
@Workflow({
  name: "credit-workflow",
  version: "1.0.0",
  flow: [
    start(CreditWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(DeskRouter)
      .chooseOne(
        route(OrderIntakeAgent)
          .returns(CreditOrderDto)
          .toRouter(CreditLimitRouter)
          .onError(CreditServiceUnavailableError, toFinish(OrderHeldWorkflowFinish))
          .chooseOne(
            route(ApprovalAgent)
              .returns(CreditApprovalDto)
              .toAction(ChargeCardAction),
            route(ChargeCardAction),
          ),
        route(NoOrderWorkflowFinish),
      ),

    // two ways in (ApprovalAgent, CreditLimitRouter): the charge's path is its own
    action(ChargeCardAction)
      .returns(ChargeResultDto)
      .toFinish(CreditWorkflowFinish),
  ],
  maxSteps: 8,
  providers: [CreditService],
})
export class CreditWorkflow {}
