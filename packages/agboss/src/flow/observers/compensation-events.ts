import type { ErrorRecord } from "../../core/error-record.js";
import type { CompensationReason, CompensationStatus } from "../compensation.js";
import type { StepRecord } from "../context/execution-context.js";
import type { NodeEvent } from "./execution-event.js";

/**
 * An automatic undo action starts (#340, `onCompensationStart`): `step` is the undo action's step
 * (its key `<compensated key>:compensation`, `step.compensates` the step it undoes), `compensated`
 * the step it undoes, `reason` why it runs. An undo on a side path is an ordinary action step.
 */
export interface CompensationStartEvent extends NodeEvent {
  /** The step the undo action undoes. */
  readonly compensated: StepRecord;
  /** Why it runs. */
  readonly reason: CompensationReason;
}

/** An automatic undo action ended (`onCompensationEnd`): how, and what it threw when it failed. */
export interface CompensationEndEvent extends CompensationStartEvent {
  /** How it ended. */
  readonly status: CompensationStatus;
  /** What it threw, when it failed. */
  readonly error?: ErrorRecord;
}
