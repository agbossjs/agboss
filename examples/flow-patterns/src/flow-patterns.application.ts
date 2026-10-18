import { Application, EmptyEnvironment } from "agboss";
import {
  ApplicationDailyBudget,
  CreditExecutionBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { CreditWorkflow } from "./credit/credit.workflow.js";
import { OfferWorkflow } from "./offer/offer.workflow.js";
import { ReviewWorkflow } from "./review/review.workflow.js";

/**
 * The patterns as one application (#261): `app.execute(OfferWorkflowStart, …)` runs the review
 * loop, `app.execute(CreditWorkflowStart, …)` the credit desk, `app.execute(ReviewWorkflowStart, …)`
 * the parallel review (#273) — each workflow by its start.
 */
@Application({
  name: "flow-patterns-application",
  version: "1.0.0",
  environment: EmptyEnvironment, // the patterns have no settings: no environment file
  workflows: [OfferWorkflow, CreditWorkflow, ReviewWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, CreditExecutionBudget, ExecutionBudget],
})
export class FlowPatternsApplication {}
