// #808 — the pauses fixture served over A2A: two skills (a text desk, a DTO audit), an approval its
// caller answers (`ThreadOwner`) and one only its channel answers.
import { A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  AuditWorkflow,
  AuditWorkflowStart,
  BatchWorkflow,
  CustomerOrderConfirmationChannel,
  DeskWorkflow,
  DeskWorkflowStart,
  FinanceDeskRefundApprovalChannel,
  PauseLog,
  SeenPausedExecutionRepository,
} from "../../channels/fixtures/pauses.workflow.js";
import { BearerCallerResolver } from "./bearer-caller-resolver.js";

@A2AExpose({
  name: "desk-a2a-expose",
  version: "2.1.0",
  description: "Refunds and confirms orders",
  exports: [DeskWorkflowStart, AuditWorkflowStart],
  skills: { "audit-workflow-start": { tags: ["audit", "refunds"], examples: ["refund order 7"] } },
  provider: { organization: "Example Corp", url: "https://example.test" },
})
export class DeskA2AExpose {}

@Application({
  name: "served-pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow, BatchWorkflow, AuditWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
    RecordingLogger,
    BearerCallerResolver,
  ],
  observers: [PauseLog],
  exposes: [DeskA2AExpose],
  budgets: TEST_BUDGETS,
})
export class ServedPausesApplication {}
