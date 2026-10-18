import { Application } from "agboss";
import {
  ApplicationDailyBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { CreditWorkflow } from "./credit/credit.workflow.js";
import { OfferWorkflow } from "./offer/offer.workflow.js";

/**
 * Both patterns as one application (#261): `app.execute(OfferWorkflowStart, …)` runs the review
 * loop, `app.execute(CreditWorkflowStart, …)` the credit desk — each workflow by its start.
 */
@Application({
  name: "flow-patterns-application",
  version: "1.0.0",
  workflows: [OfferWorkflow, CreditWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class FlowPatternsApplication {}
