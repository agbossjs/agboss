// #808 — the pauses fixture served over A2A: two skills (a text desk, a DTO audit), an approval its
// caller answers (`ThreadOwner`) and one only its channel answers.
import { hours, minutes } from "../../../src/units/index.js";
import { A2AEndpoint } from "../../../src/a2a/a2a-endpoint.decorator.js";
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
  AutoRefundChannel,
  PauseLog,
  SeenPausedExecutionRepository,
} from "../../channels/fixtures/pauses.workflow.js";
import { BearerAuthenticator } from "./bearer-authenticator.js";

@A2AEndpoint({
  name: "desk-a2a-expose",
  version: "2.1.0",
  description: "Refunds and confirms orders",
  provider: { organization: "Example Corp", url: "https://example.test" },
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [
    DeskWorkflowStart,
    { start: AuditWorkflowStart, tags: ["audit", "refunds"], examples: ["refund order 7"] },
  ],
})
export class DeskA2AExpose {}

@Application({
  name: "served-pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DeskWorkflow, BatchWorkflow, AuditWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    AutoRefundChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
    RecordingLogger,
    BearerAuthenticator,
  ],
  observers: [PauseLog],
  endpoints: [DeskA2AExpose],
  budgets: TEST_BUDGETS,
})
export class ServedPausesApplication {}
