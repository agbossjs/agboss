import { Application, SqliteCostLedgerRepository } from "agboss";
import {
  ApplicationDailyBudget,
  CreditExecutionBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { CreditWorkflow } from "./credit/credit.workflow.js";
import { OfferWorkflow } from "./offer/offer.workflow.js";
import { PanelWorkflow } from "./panel/panel.workflow.js";
import { ReviewWorkflow } from "./review/review.workflow.js";
import { VendorScreeningWorkflow } from "./vendor/vendor-screening.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";

/**
 * The patterns as one application (#261): `app.execute(OfferWorkflowStart, …)` runs the review
 * loop, `app.execute(CreditWorkflowStart, …)` the credit desk, `app.execute(ReviewWorkflowStart, …)`
 * the parallel review (#273), `app.execute(PanelWorkflowStart, …)` the panel's quorum (#279),
 * `app.execute(VendorScreeningWorkflowStart, …)` a child workflow per vendor (#263) — each workflow by
 * its start. The child `VendorCheckWorkflow` is not listed: a child workflow belongs to the
 * application of its parent, and `app.execute(VendorCheckWorkflowStart, …)` runs it alone. Its tenant and application budgets are
 * counted in a SQLite ledger (#261: the built-in in-memory one is an assembly warning, an error
 * under `agboss check --strict`); nothing pauses, so the paused executions stay in memory.
 */
@Application({
  name: "flow-patterns-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [
    OfferWorkflow,
    CreditWorkflow,
    ReviewWorkflow,
    PanelWorkflow,
    VendorScreeningWorkflow,
  ],
  providers: [SqliteCostLedgerRepository],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, CreditExecutionBudget, ExecutionBudget],
})
export class FlowPatternsApplication {}
