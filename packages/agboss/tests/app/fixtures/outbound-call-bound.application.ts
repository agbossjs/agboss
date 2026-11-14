import { Injectable, InMemoryFencedEffectRepository } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { StoreClock } from "../../../src/infrastructure/clock.js";
import { ExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecordingLogger } from "../../helpers/log.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import {
  CashierWorkflow,
  ChargeOrderWorkflow,
  SendChargeWorkflow,
  SendChargesWorkflow,
} from "./business-key.workflow.js";
import {
  ChargeAndNotifyWorkflow,
  ChargeWorkflow,
  EmailPiiPolicy,
  OutboundCallLog,
} from "./outbound-call.workflow.js";

/**
 * #928 AC2 — the outbound-call store whose `markCompleted` can answer with an error, once
 * (`down.markCompleted`, `down.markFailed`), and whose operations a test can hold for ever (`withHoldPoints`, deaf to
 * the step's signal): the charge workflow of #505 and the business-key workflows of #508 on it.
 */
export const down = { markCompleted: 0, markFailed: 0 };

@Injectable({ deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] })
export class DownableOutbound extends InMemoryOutboundCallRepository {
  override markCompleted(
    ...args: Parameters<InMemoryOutboundCallRepository["markCompleted"]>
  ): ReturnType<InMemoryOutboundCallRepository["markCompleted"]> {
    if (down.markCompleted <= 0) return super.markCompleted(...args);
    down.markCompleted -= 1;
    return Promise.reject(new Error("the outbound store is down"));
  }

  override markFailed(
    ...args: Parameters<InMemoryOutboundCallRepository["markFailed"]>
  ): ReturnType<InMemoryOutboundCallRepository["markFailed"]> {
    if (down.markFailed <= 0) return super.markFailed(...args);
    down.markFailed -= 1;
    return Promise.reject(new Error("the outbound store is down"));
  }
}

export const HeldOutbound = withHoldPoints(DownableOutbound);

/** The charge workflow of #505 (`charge-workflow`) on the held outbound store. */
@Application({
  name: "outbound-call-bound-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow, ChargeAndNotifyWorkflow],
  observers: [RecoveryLog, OutboundCallLog],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
  providers: [HeldOutbound, RecordingLogger],
})
export class OutboundCallBoundApplication {}

/** The business-key workflows of #508 (`send-charge-workflow`: `order:<id>`) on the held outbound store. */
@Application({
  name: "outbound-call-bound-keyed-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [CashierWorkflow, ChargeOrderWorkflow, SendChargeWorkflow, SendChargesWorkflow],
  providers: [...MODEL_PROVIDERS, InMemoryFencedEffectRepository, HeldOutbound, RecordingLogger],
  budgets: TEST_BUDGETS,
  observers: [RecoveryLog],
})
export class OutboundCallBoundKeyedApplication {}
