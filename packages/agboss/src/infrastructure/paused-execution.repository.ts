import { Injectable } from "../components/decorators.js";
import { threadMapKeyOf } from "./in-memory-database.js";
import type { PausedExecution } from "../app/paused-runs.js";
import {
  cancelledPause,
  decidedPause,
  isExpiredPause,
  PauseStatus,
  resolvedPause,
  type PauseAnswer,
  type PauseCancellation,
  type PauseRecord,
} from "./pause-record.js";

export {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseCancellation,
  type PauseRecord,
} from "./pause-record.js";

/**
 * Infrastructure (#261 S28, #265, #267 S35): the application's paused executions and their pauses.
 *
 * - **The paused tree, by thread** (tenant + thread): the run as it rested and the workflow
 *   version / config hash it paused under (checked on resume).
 * - **Its pauses, by id**: one record per waiting step (its `step.idempotencyKey`), made before
 *   the channel is asked; a resume finds it by `(tenantId, pauseId)` anywhere in the tree and turns
 *   it from `Pending` to `Resolved` with its decision, atomically — of two concurrent resumes of
 *   one pause exactly one does (Q58). A resolved record (`Taken`, `Cancelled`) is kept for
 *   `@Application({ pauseRecordRetention })` after it was resolved — a late answer gets
 *   `NotPausedError` — then removed by the recovery sweep (`deleteResolvedBefore`, #267 S107).
 *
 * One per application, listed only in `@Application({ providers })`; the built-in default is in
 * memory. A pause survives a restart only when this repository and the checkpointer
 * (`BaseCheckpointSaver`) are both durable. Your own `extends PausedExecutionRepository`.
 */
export abstract class PausedExecutionRepository {
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;
  /** The execution paused on the tenant's thread; `undefined` when none waits there. */
  abstract findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined>;

  /** Keeps a paused execution (one per thread of its `run.tenantId`: a later pause replaces it). */
  abstract save(paused: PausedExecution): Promise<void>;

  /** Forgets the thread's paused execution (it was resumed to its end, or cancelled). */
  abstract deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void>;

  /**
   * Atomic: the pause of `pause.stepKey` in its tenant when one exists, else `pause` saved and
   * returned — so a step re-entered (a resume of a sibling, a retry after a crash) keeps its id.
   */
  abstract findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord>;

  /** The tenant's pause of that id; `undefined` when the tenant has none (another tenant's too). */
  abstract findByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
  ): Promise<PauseRecord | undefined>;

  /** Every pause of the tree, whatever its status. */
  abstract findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]>;

  /**
   * Atomic, only while `Pending`: marks the pause's channel asked; `false` when it is no longer
   * pending (a fast reply resolved it while `send` was still returning) — nothing is overwritten.
   */
  abstract markSentByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean>;

  /**
   * Atomic: turns the pause from `Pending` to `Resolved` with `answer` (`PauseResolution.Replied`,
   * resolved `at`) and returns it; `undefined` when it is not pending (another resume answered it,
   * it was cancelled, or none).
   */
  abstract resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined>;

  /**
   * Atomic: its channel decided at once (`ChannelOutcome.decided`) — the pause goes from `Pending`
   * to `Taken` with `answer` (`PauseResolution.Decided`); `false` when it was not pending.
   */
  abstract decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean>;

  /**
   * Atomic: turns the pause from `Pending` to `Cancelled` — `Withdrawn` (a `FailFast` sibling
   * failed) or `Cancelled` (`app.cancel`, its tree ended); `false` when it was not pending.
   */
  abstract cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
  ): Promise<boolean>;

  /** Turns a `Resolved` pause to `Taken`: its step took the decision (the pass that ran it returned). */
  abstract markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void>;

  /**
   * Removes every `Taken` and `Cancelled` pause of every tenant resolved before `cutoff` (the
   * recovery sweep, `now - pauseRecordRetention`); `Pending` and `Resolved` ones are never removed.
   */
  abstract deleteResolvedBefore(cutoff: Date): Promise<void>;
}

const pauseKeyOf = (tenantId: string, pauseId: string): string =>
  JSON.stringify([tenantId, pauseId]);

/**
 * The built-in default: paused executions in memory — another application instance cannot resume
 * them, and they are lost on restart. Every operation is one synchronous step, so it is atomic.
 */
@Injectable()
export class InMemoryPausedExecutionRepository extends PausedExecutionRepository {
  readonly #paused = new Map<string, PausedExecution>();
  readonly #pauses = new Map<string, PauseRecord>();

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedExecution | undefined> {
    return Promise.resolve(this.#paused.get(threadMapKeyOf({ tenantId, threadId })));
  }

  save(paused: PausedExecution): Promise<void> {
    this.#paused.set(threadMapKeyOf(paused.run), paused);
    return Promise.resolve();
  }

  deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    this.#paused.delete(threadMapKeyOf({ tenantId, threadId }));
    return Promise.resolve();
  }

  findOrCreateByStepKey(pause: PauseRecord): Promise<PauseRecord> {
    const found = [...this.#pauses.values()].find(
      (stored) => stored.tenantId === pause.tenantId && stored.stepKey === pause.stepKey,
    );
    if (found !== undefined) return Promise.resolve(found);
    this.#pauses.set(pauseKeyOf(pause.tenantId, pause.pauseId), pause);
    return Promise.resolve(pause);
  }

  findByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<PauseRecord | undefined> {
    return Promise.resolve(this.#pauses.get(pauseKeyOf(tenantId, pauseId)));
  }

  findAllByTenantIdAndRootExecutionId(
    tenantId: string,
    rootExecutionId: string,
  ): Promise<readonly PauseRecord[]> {
    return Promise.resolve(
      [...this.#pauses.values()].filter(
        (pause) => pause.tenantId === tenantId && pause.rootExecutionId === rootExecutionId,
      ),
    );
  }

  markSentByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean> {
    return Promise.resolve(
      this.#transition(tenantId, pauseId, (pause) => ({ ...pause, isSent: true })) !== undefined,
    );
  }

  resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.#transition(tenantId, pauseId, (pause) => resolvedPause(pause, answer, at)),
    );
  }

  decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    answer: PauseAnswer,
    at: Date,
  ): Promise<boolean> {
    const decided = this.#transition(tenantId, pauseId, (pause) => decidedPause(pause, answer, at));
    return Promise.resolve(decided !== undefined);
  }

  cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseCancellation,
    at: Date,
  ): Promise<boolean> {
    const cancelled = this.#transition(tenantId, pauseId, (pause) =>
      cancelledPause(pause, resolution, at),
    );
    return Promise.resolve(cancelled !== undefined);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    const key = pauseKeyOf(tenantId, pauseId);
    const stored = this.#pauses.get(key);
    if (stored?.status === PauseStatus.Resolved)
      this.#pauses.set(key, { ...stored, status: PauseStatus.Taken });
    return Promise.resolve();
  }

  deleteResolvedBefore(cutoff: Date): Promise<void> {
    for (const [key, pause] of this.#pauses) {
      if (isExpiredPause(pause, cutoff)) this.#pauses.delete(key);
    }
    return Promise.resolve();
  }

  /** Changes a `Pending` pause; `undefined` when it is not pending (or none). */
  #transition(
    tenantId: string,
    pauseId: string,
    change: (pause: PauseRecord) => PauseRecord,
  ): PauseRecord | undefined {
    const key = pauseKeyOf(tenantId, pauseId);
    const stored = this.#pauses.get(key);
    if (stored?.status !== PauseStatus.Pending) return undefined;
    const changed = change(stored);
    this.#pauses.set(key, changed);
    return changed;
  }
}
