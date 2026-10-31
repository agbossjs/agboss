import { EmptyEnvironment } from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { hours, seconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import {
  MortalExecutionLeaseRepository,
  StampedExecutionRecordRepository,
} from "../../../infrastructure/fixtures/recovery.workflow.js";
import { UnwindLog, UnwindParentWorkflow, UnwindWorkflow } from "./unwind.workflow.js";

/**
 * #340 PR 4 — the undo of `unwind.workflow.ts` across instances: a lease store whose instances the
 * test can kill (`kill("instance-1")`: no lease taken or renewed — a crash, to the store) and the
 * records the test reads (`stores.records`), with an undo bound longer than a lease, so an undo in
 * flight is stopped by a lost lease or the app's stop, never by its own timeout.
 */
@Application({
  name: "unwind-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnwindWorkflow, UnwindParentWorkflow],
  observers: [UnwindLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
  compensationTimeout: seconds(60),
})
export class UnwindRecoveryApplication {}

/** The same application keeping its executions' history (#484: the undo a takeover finished is in it). */
@Application({
  name: "kept-unwind-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnwindWorkflow, UnwindParentWorkflow],
  observers: [UnwindLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
  compensationTimeout: seconds(60),
  executionRecordRetention: hours(24),
})
export class KeptUnwindRecoveryApplication {}
