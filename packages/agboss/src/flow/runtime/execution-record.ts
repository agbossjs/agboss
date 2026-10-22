import type { CompensationRecord } from "../compensation.js";
import type { ErrorRecord } from "../../core/error-record.js";
import type { CostReport } from "../../finops/usage.js";
import type { OutdatedValueRecord, ScopeValueRecord } from "./records.js";
import type { ChildExecutionRecord } from "./child-records.js";
import type { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import type { PauseResolution } from "../../infrastructure/pause-record.js";
import type { StepRecord } from "../context/execution-context.js";

/**
 * The full record of one execution (#270 AC16), returned only with `app.execute(…, { record: true })`:
 * the path, every value of the path scope (with who gave it and what it was built from), the values
 * moved out of it (#271), the last handled error, the spend, its child executions, each nested
 * the same way (#263) with the pauses it asked (#267 S124 c), and who answered each pause of its
 * tree and how (#267 S107).
 * `result.output` stays the business result only.
 */
export interface ExecutionRecord {
  readonly path: readonly string[];
  readonly scope: readonly ScopeValueRecord[];
  readonly outdatedValues: readonly OutdatedValueRecord[];
  readonly lastError?: ErrorRecord;
  readonly spend: CostReport;
  /** Its child executions that ended — finished, failed or cancelled — nested (#263). */
  readonly children: readonly ChildExecutionRecord[];
  /**
   * Every pause of its tree that was resolved, in the order they were asked (#267 S107): the audit
   * trail of who answered what. A pause still pending is in `result.pending` only.
   */
  readonly pauses: readonly PauseAnswerRecord[];
  /** The undo actions that ran (#340), in the order they ended (`result.compensations`). */
  readonly compensations: readonly CompensationRecord[];
}

/** One resolved pause as the execution record keeps it (#267 S107), masked like the rest of it. */
export interface PauseAnswerRecord {
  /** Its id — `undefined` for a `PauseAnswerer.Channel` pause: only its channel has it (S100 b). */
  readonly pauseId: string | undefined;
  /** The execution it waited in: the root's, or a child's (its `ChildExecutionRecord.pauses`, S124 c). */
  readonly executionId: string;
  /** The waiting step: its agent, node, visit, copy, item and tool call. */
  readonly step: StepRecord;
  /** The channel asked: a role's name or a concrete `@Channel`'s. */
  readonly role: string;
  /** Who may answer it (its role's `answeredBy`). */
  readonly answeredBy: PauseAnswerer;
  /**
   * Who answered: the `ownerId` or the `answeredBy` credential of `app.resume`; `undefined` when
   * its channel decided at once, it was withdrawn or cancelled, or its thread has no owner.
   */
  readonly responder: string | undefined;
  readonly resolution: PauseResolution;
  /** When it was asked and resolved (ISO 8601, the application's `Clock`). */
  readonly askedAt: string;
  readonly resolvedAt: string | undefined;
  /** What was decided, PII-masked; `undefined` when it was withdrawn or cancelled. */
  readonly decision: unknown;
}
