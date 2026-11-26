import { InMemoryPauseBook } from "./in-memory-pause-book.js";
import { timeoutChange } from "./pause-timeout-change.js";
import { InMemoryPauseQueryRepository } from "./in-memory-pause-queries.js";
import {
  isInPlace,
  type PauseTimeoutChange,
  type PauseReassignmentChange,
  type PauseRecipients,
} from "./pause-notices.js";
import {
  decidedPause,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PauseExpiry,
  type PauseRecord,
  type PauseUntakenResolution,
} from "./pause-record.js";
import { reassignChange } from "./pause-reassign-transition.js";
import {
  cancelChange,
  closeUntakenChange,
  expireChange,
  markSentChange,
  remindChange,
  resolveChange,
} from "./pause-transitions.js";

/**
 * The in-memory pause store's logic: behind `InMemoryPausedExecutionRepository`. A
 * change is planned by `pause-transitions.ts` (the same conditions every core store reads), then
 * applied with its notices, nothing that can fail in between: one synchronous step.
 */
export class InMemoryPauseStore extends InMemoryPauseQueryRepository {
  protected readonly book = new InMemoryPauseBook();

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    const found = this.#find(pause.tenantId, pause.rootExecutionId, pause.stepKey);
    if (found !== undefined) return Promise.resolve(found);
    this.book.insert(pause);
    return Promise.resolve(pause);
  }

  findByTenantIdAndRootExecutionIdAndStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(this.#find(tenantId, rootExecutionId, stepKey));
  }

  findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    return Promise.resolve(this.book.find(tenantId, pauseId));
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    return Promise.resolve(
      this.pauses().filter(
        (pause) => pause.tenantId === tenantId && pause.rootExecutionId === rootExecutionId,
      ),
    );
  }

  markSentByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    recipients: PauseRecipients,
    externalRef?: string,
  ): Promise<boolean> {
    const sent = this.book.change(tenantId, pauseId, (pause) =>
      markSentChange(pause, recipients, externalRef),
    );
    return Promise.resolve(sent?.status === PauseStatus.Pending);
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.book.change(tenantId, pauseId, (pause) => resolveChange(pause, answer, at, recipients)),
    );
  }

  decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    const decided = this.book.change(tenantId, pauseId, (pause) =>
      pause.status === PauseStatus.Pending
        ? { pause: decidedPause(pause, answer, at), notices: [] }
        : undefined,
    );
    return Promise.resolve(decided !== undefined);
  }

  cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.book.change(tenantId, pauseId, (pause) =>
        cancelChange(pause, resolution, at, recipients),
      ),
    );
  }

  expireByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    expiry: PauseExpiry,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.book.change(tenantId, pauseId, (pause) => expireChange(pause, expiry, at, recipients)),
    );
  }

  closeUntakenByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseUntakenResolution,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.book.change(tenantId, pauseId, (pause) =>
        closeUntakenChange(pause, resolution, at, recipients),
      ),
    );
  }

  changeTimeoutByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseTimeoutChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.book.change(tenantId, pauseId, (pause) => timeoutChange(pause, change, at, recipients)),
    );
  }

  reassignByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    replacement: PauseReassignmentChange,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    const reassigned = this.book.change(tenantId, pauseId, (pause) =>
      reassignChange(pause, replacement, this.#stepKeysOf(pause), at, recipients),
    );
    if (reassigned === undefined) return Promise.resolve(undefined);
    // in place: the pause itself; otherwise its replacement
    return Promise.resolve(
      this.book.find(tenantId, isInPlace(replacement) ? pauseId : replacement.pauseId),
    );
  }

  remindByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    const reminded = this.book.change(tenantId, pauseId, (pause) =>
      remindChange(pause, at, recipients),
    );
    return Promise.resolve(reminded !== undefined);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    this.book.change(tenantId, pauseId, (pause) =>
      pause.status === PauseStatus.Resolved
        ? { pause: { ...pause, status: PauseStatus.Taken }, notices: [] }
        : undefined,
    );
    return Promise.resolve();
  }

  /** The step keys of the pause's tree. */
  #stepKeysOf({ tenantId, rootExecutionId }: PauseRecord): ReadonlySet<string> {
    return new Set(
      this.pauses()
        .filter((pause) => pause.tenantId === tenantId && pause.rootExecutionId === rootExecutionId)
        .map((pause) => pause.stepKey),
    );
  }

  #find(tenantId: string, rootExecutionId: string, stepKey: string): PauseRecord | undefined {
    return this.pauses().find(
      (pause) =>
        pause.tenantId === tenantId &&
        pause.rootExecutionId === rootExecutionId &&
        pause.stepKey === stepKey,
    );
  }
}
