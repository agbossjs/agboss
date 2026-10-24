import {
  Application,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
} from "agboss";
import { DecisionsModelProvider, OpenRouterModelProvider } from "agboss/models";
import { OffsiteBookingWorkflow } from "./approvals/offsite-booking.workflow.js";
import { TerminalPurchaseApprovalChannel } from "./approvals/channels/terminal-purchase-approval.channel.js";
import {
  ApplicationDailyBudget,
  CreditExecutionBudget,
  ExecutionBudget,
  TenantDailyBudget,
  TopicResearchExecutionBudget,
} from "./config/budget.config.js";
import { CreditWorkflow } from "./credit/credit.workflow.js";
import { DeskWorkflow } from "./desk/desk.workflow.js";
import { OrderDeskHealthCheck } from "./desk/health/order-desk.health-check.js";
import { DeskMetricsObserver } from "./desk/observers/desk-metrics.observer.js";
import { DeskMetricsService } from "./desk/services/desk-metrics.service.js";
import { IntakeWorkflow } from "./intake/intake.workflow.js";
import { HelplineWorkflow } from "./helpline/helpline.workflow.js";
import { HarnessModelProvider } from "./model-providers/harness.model-provider.js";
import { OfferWorkflow } from "./offer/offer.workflow.js";
import { PanelWorkflow } from "./panel/panel.workflow.js";
import { RecruiterInboxChannel } from "./hiring/channels/recruiter-inbox.channel.js";
import { SendOfferWorkflow } from "./hiring/send-offer.workflow.js";
import { TripWorkflow } from "./travel/trip.workflow.js";
import { ReviewWorkflow } from "./review/review.workflow.js";
import { TopicResearchWorkflow } from "./topic/topic-research.workflow.js";
import { VendorScreeningWorkflow } from "./vendor/vendor-screening.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";

/**
 * The patterns as one application (#261): `app.execute(OfferWorkflowStart, …)` runs the review
 * loop, `app.execute(CreditWorkflowStart, …)` the credit desk, `app.execute(ReviewWorkflowStart, …)`
 * the parallel review (#273), `app.execute(PanelWorkflowStart, …)` the panel's quorum (#279),
 * `app.execute(VendorScreeningWorkflowStart, …)` a child workflow per vendor (#263),
 * `app.execute(TopicResearchWorkflowStart, …)` a workflow researching its subtopics itself (#264),
 * `app.execute(OffsiteBookingWorkflowStart, …)` two approvals at once (#267),
 * `app.execute(SendOfferWorkflowStart, …)` an offer whose steps declare their undo (#339),
 * `app.execute(TripWorkflowStart, …)` two bookings a failed join undoes automatically (#340),
 * `app.execute(DeskWorkflowStart, …)` the extension points on an offline model (#382–#385),
 * `app.execute(HelplineWorkflowStart, …)` a call to `desk-application` over A2A (#398),
 * `app.execute(IntakeWorkflowStart, …)` a quorum by groups (#279) — each
 * workflow by its start. The child `VendorCheckWorkflow` is not listed: a child workflow belongs to the application
 * of its parent, and `app.execute(VendorCheckWorkflowStart, …)` runs it alone.
 *
 * Its infrastructure is SQLite (#265) on the environment's `sqlitePath`: the ledger of its tenant
 * and application budgets, the records, the pauses, the checkpoints, the leases and the tree keys —
 * so two pauses wait at once and survive a restart, and another instance on the file continues
 * them (#261: an in-memory ledger or pause store is an assembly warning, an error under
 * `agboss check --strict`). Its model providers (#266) are the built-in OpenRouter and Decisions ones — catch-alls that
 * yield `harness/…` to the transport that claims it (#454) — — they read `openRouterApiKey` (and `openRouterBaseUrl`) of the environment — and the offline
 * transport `HarnessModelProvider` for the `harness/…` models (#385), which needs no key. The
 * purchase approvals are asked in the terminal (`TerminalPurchaseApprovalChannel`, the one
 * implementation of their role). Its PII key is an environment secret (#120 S94: without one, a
 * key of each execution — a warning).
 */
@Application({
  name: "flow-patterns-application",
  version: "1.0.0",
  environment: AppEnvironment,
  pseudonymKey: "piiPseudonymKey", // one PII token per value on every instance (#120)
  workflows: [
    OfferWorkflow,
    CreditWorkflow,
    ReviewWorkflow,
    PanelWorkflow,
    VendorScreeningWorkflow,
    TopicResearchWorkflow,
    OffsiteBookingWorkflow,
    SendOfferWorkflow,
    TripWorkflow,
    DeskWorkflow,
    HelplineWorkflow,
    IntakeWorkflow,
  ],
  observers: [DeskMetricsObserver],
  healthChecks: [OrderDeskHealthCheck],
  maxConcurrentSteps: 16, // agent, router and action steps of one instance at once (#332)
  providers: [
    DeskMetricsService, // the observer's
    OpenRouterModelProvider, // every chat model but harness/… (#454: a built-in yields)
    DecisionsModelProvider, // Jev and the other decision models
    HarnessModelProvider, // harness/…, offline
    TerminalPurchaseApprovalChannel,
    RecruiterInboxChannel,
    SqliteCostLedgerRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteExecutionLeaseRepository,
    SqliteExecutionTreeRepository,
  ],
  budgets: [
    ApplicationDailyBudget,
    TenantDailyBudget,
    CreditExecutionBudget,
    TopicResearchExecutionBudget,
    ExecutionBudget,
  ],
})
export class FlowPatternsApplication {}
