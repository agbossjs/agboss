import type {
  PauseExtension,
  PauseNoticeFacts,
  PauseNoticeKind,
  PauseRecipients,
} from "../pause-notices.js";
import {
  decidedPause,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PauseExpiry,
  type PauseRecord,
  type PauseUntakenResolution,
} from "../pause-record.js";
import {
  cancelChange,
  closeUntakenChange,
  expireChange,
  extendChange,
  markSentChange,
  onceNotices,
  remindChange,
  resolveChange,
  type PauseChange,
} from "../pause-transitions.js";
import { oneRowChanged } from "./sqlite-connection.js";
import { SqlitePauseQueryRepository } from "./sqlite-pause-queries.repository.js";

/**
 * The SQLite pause store's logic: loaded by `SqlitePausedExecutionRepository` when it starts. One row
 * per thread of a tenant (#261) — the paused run and the versions it paused under —, one row per
 * pause (`pauses`) and one row per pause and receiver (`pause_notices`, the notices). Every change
 * of a pause is one `BEGIN IMMEDIATE` transaction, the change planned by the same pure rules the
 * in-memory store reads (`pause-transitions.ts`) and its notices written in that transaction: of
 * two resumes on two instances exactly one records its decision, and a notice is never without its
 * change nor a change without its notice.
 */
export class SqlitePauseStore extends SqlitePauseQueryRepository {
  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    const found = this.connection.transaction((): PauseRecord => {
      const stored = this.pauses.findByStepKey(pause);
      if (stored !== undefined) return stored;
      this.pauses.insert(pause);
      return pause;
    });
    return Promise.resolve(found);
  }

  findByTenantIdAndRootExecutionIdAndStepKey(
    tenantId: string,
    rootExecutionId: string,
    stepKey: string,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(this.pauses.findByTree(tenantId, rootExecutionId, stepKey));
  }

  findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    return Promise.resolve(this.pauses.findById(tenantId, pauseId));
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    return Promise.resolve(this.pauses.findAllByRoot(tenantId, rootExecutionId));
  }

  markSentByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    const sent = this.#change(tenantId, pauseId, (pause) => markSentChange(pause, recipients));
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
      this.#change(tenantId, pauseId, (pause) => resolveChange(pause, answer, at, recipients)),
    );
  }

  decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    const decided = this.#change(tenantId, pauseId, (pause) =>
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
      this.#change(tenantId, pauseId, (pause) => cancelChange(pause, resolution, at, recipients)),
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
      this.#change(tenantId, pauseId, (pause) => expireChange(pause, expiry, at, recipients)),
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
      this.#change(tenantId, pauseId, (pause) =>
        closeUntakenChange(pause, resolution, at, recipients),
      ),
    );
  }

  extendByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    change: PauseExtension,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.#change(tenantId, pauseId, (pause) => extendChange(pause, change, at, recipients)),
    );
  }

  remindByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    const reminded = this.#change(tenantId, pauseId, (pause) =>
      remindChange(pause, at, recipients),
    );
    return Promise.resolve(reminded !== undefined);
  }

  noticeOnceByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    kind: PauseNoticeKind,
    facts: PauseNoticeFacts,
    at: Date,
    recipients: PauseRecipients,
  ): Promise<boolean> {
    const wrote = this.connection.transaction(() => {
      const pause = this.pauses.findById(tenantId, pauseId);
      if (pause === undefined || this.notices.hasNoticeOf(tenantId, pauseId, kind)) return false;
      const notices = onceNotices(pause, kind, facts, at, recipients);
      this.notices.append(pause, notices);
      return notices.length > 0;
    });
    return Promise.resolve(wrote);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    this.#change(tenantId, pauseId, (pause) =>
      pause.status === PauseStatus.Resolved
        ? { pause: { ...pause, status: PauseStatus.Taken }, notices: [] }
        : undefined,
    );
    return Promise.resolve();
  }

  /**
   * One transaction: the pause read, the change planned, written over the status it was read at
   * and its notices appended — all or nothing. The changed record, or `undefined`.
   */
  #change(
    tenantId: string,
    pauseId: string,
    plan: (current: PauseRecord) => PauseChange | undefined,
  ): PauseRecord | undefined {
    return this.connection.transaction(() => {
      const current = this.pauses.findById(tenantId, pauseId);
      const change = current === undefined ? undefined : plan(current);
      if (current === undefined || change === undefined) return undefined;
      oneRowChanged(this.pauses.write(change.pause, current.status) ? 1 : 0);
      this.notices.append(change.pause, change.notices);
      return change.pause;
    });
  }
}
