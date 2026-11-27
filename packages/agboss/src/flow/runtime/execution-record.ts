import type { CompensationRecord } from "../compensation.js";
import type { ErrorRecord } from "../../core/error-record.js";
import type { CostReport } from "../../finops/usage.js";
import type { OutdatedValueRecord, ScopeValueRecord } from "./records.js";
import type { ChildExecutionRecord } from "./child-records.js";
import type { PauseActor, PauseTrailEntry } from "../../channels/pause-contexts.js";
import type { PauseResolution } from "../../infrastructure/pause-record.js";
import type { StepRecord } from "../context/execution-context.js";
import type { ToolCallRecord } from "./tool-calls.js";
import type { ExecutionStepRecord } from "./step-records.js";
import type { ExecutionOrigin } from "../../mesh/mesh-envelope.js";
import { type PauseRespondent } from "../../pause/respondent.js";

/**
 * The full record of one execution (#270 AC16), returned only with `app.execute(…, { includeRecord: true })`:
 * the path, every value of the path scope (with who gave it and what it was built from), the values
 * moved out of it (#271), the last handled error, the spend, its child executions, each nested
 * the same way (#263) with the pauses it asked (#267 S124 c), and who answered each pause of its
 * tree and how (#267 S107).
 * `result.output` stays the business result only.
 */
export interface ExecutionRecord<TPause = PauseAnswerRecord> {
  readonly path: readonly string[];
  readonly scope: readonly ScopeValueRecord[];
  readonly outdatedValues: readonly OutdatedValueRecord[];
  readonly lastError?: ErrorRecord;
  readonly spend: CostReport;
  /** Its child executions that ended — finished, failed or cancelled — nested (#263). */
  readonly children: readonly ChildExecutionRecord<TPause>[];
  /**
   * Every pause of its tree that was resolved, in the order they were asked (#267 S107): the audit
   * trail of who answered what. A pause still pending is in `result.pending` only.
   */
  readonly pauses: readonly TPause[];
  /** The undo actions that ran (#340), in the order they ended (`result.compensations`). */
  readonly compensations: readonly CompensationRecord[];
  /** Its own agents' tool calls (#395), in call order; a child's are in its `ChildExecutionRecord`. */
  readonly toolCalls: readonly ToolCallRecord[];
  /**
   * One record per visit of its own nodes (#395 C3), in the order the visits ended: the step, a
   * hash of its input, what it decided (#401: a route, a variant's class or a hash of its answer —
   * never the answer itself), its judges' verdicts and guardrails' decisions, its spend and times.
   */
  readonly steps: readonly ExecutionStepRecord[];
  /**
   * Where its request came from (#398 PR 2): the calling application, execution, workflow and step
   * — set only for a trusted mesh peer's request.
   */
  readonly origin?: ExecutionOrigin;
}

/**
 * One resolved pause as the execution record store keeps it and `result.record.pauses` shows it
 * (#267 S107), masked like the rest of it. Its times are `Date`s (#1307, G3): a store writes them as
 * ISO 8601 texts (`toISOString()`) in its JSON and reads the canonical text back with
 * `pauseAnswerRecordOfValue`.
 */
export interface PauseAnswerRecord {
  /** Its id — `undefined` for a `PauseRespondent.Delegate` pause: only its channel has it (S100 b). */
  readonly pauseId: string | undefined;
  /** The execution it waited in: the root's, or a child's (its `ChildExecutionRecord.pauses`, S124 c). */
  readonly executionId: string;
  /** The waiting step: its agent, node, visit, copy, item and tool call. */
  readonly step: StepRecord;
  /** The pause target it waited under. */
  readonly target: string;
  /** The channel asked; absent for an owner's pause nobody was asked about. */
  readonly channel?: string;
  /** Who may answer it (its target's `respondent`). */
  readonly respondent: PauseRespondent;
  /**
   * Who answered: the owner (`{ id: ownerId }`) or the `actor` of `app.resume`; `undefined` when
   * its channel decided at once, it was withdrawn or cancelled, or its thread has no owner.
   */
  readonly actor: PauseActor | undefined;
  readonly resolution: PauseResolution;
  /** When it was asked and resolved (the application's `Clock`). */
  readonly askedAt: Date;
  readonly resolvedAt: Date | undefined;
  /** What was decided, PII-masked; `undefined` when it was withdrawn or cancelled. */
  readonly decision: unknown;
  /**
   * What was asked, PII-masked (#688): an approval's call arguments as the agent made them, before
   * any correction, or a question's ask. Beside `decision` (the call as it ran, a correction laid
   * over it) it makes every change a reply made auditable.
   */
  readonly input: unknown;
  /** The tool call an approval waited on, PII-masked; absent for a question. */
  readonly toolCall?: unknown;
  /** Who it was for when it closed, PII-masked; absent: nobody in particular. */
  readonly assignees?: readonly string[];
  /** The id its channel's system gave it (a ticket key), PII-masked. */
  readonly externalRef?: string;
  /** Its chain of custody, newest last, PII-masked: who opened and reassigned it, when, why. */
  readonly trail: readonly PauseTrailEntry[];
  /**
   * `false` when an answer was recorded and its run never applied it (its tree ended before the step
   * took it; I12): the answer and who gave it are kept. Absent: taken, or no answer.
   */
  readonly isTaken?: false;
}
