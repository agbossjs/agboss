import { EmptyEnvironment } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { hours, seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  MortalExecutionLeaseRepository,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  GuestInboxChannel,
  UnwindGuestWorkflow,
} from "../../flow/runtime/fixtures/unwind-pause.workflow.js";
import {
  UnwindLog,
  UnwindManyWorkflow,
  UnwindSidePathWorkflow,
  UnwindWorkflow,
} from "../../flow/runtime/fixtures/unwind.workflow.js";

/**
 * #635 — every way a root's tree ends undone, its history kept (`executionRecordRetention`): a
 * pass's own failure, a failed undo, a cancel, a side path's undo before the failure, a failed
 * per-item child, a paused tree cancelled — and a lease store whose instances a test can kill, so
 * the pass that fails can be the new holder's.
 */
@Application({
  name: "kept-undo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnwindWorkflow, UnwindSidePathWorkflow, UnwindManyWorkflow, UnwindGuestWorkflow],
  observers: [UnwindLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository, GuestInboxChannel],
  budgets: TEST_BUDGETS,
  compensationTimeout: seconds(60),
  executionRecordRetention: hours(24),
})
export class KeptUndoApplication {}
