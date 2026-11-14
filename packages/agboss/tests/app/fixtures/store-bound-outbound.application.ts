import { Application } from "../../../src/application/application.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecordingLogger } from "../../helpers/log.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { ChargeWorkflow, EmailPiiPolicy } from "./outbound-call.workflow.js";

/** #928 — the outbound charge on lease and call stores a test can hold (deaf to the step's signal). */
export const HeldOutboundLeases = withHoldPoints(InMemoryExecutionLeaseRepository);
export const HeldOutboundCalls = withHoldPoints(InMemoryOutboundCallRepository);

@Application({
  name: "store-bound-outbound-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
  providers: [HeldOutboundLeases, HeldOutboundCalls, RecordingLogger],
})
export class StoreBoundOutboundApplication {}
