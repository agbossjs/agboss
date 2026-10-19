import { Injectable } from "../components/decorators.js";
import { threadMapKeyOf } from "./thread-map-key.js";
import type { PausedRun } from "../app/paused-runs.js";
import {
  PauseStatus,
  resolvedPause,
  type PauseRecord,
  type PauseResolution,
} from "./pause-record.js";

export { PauseStatus, type PauseRecord, type PauseResolution } from "./pause-record.js";

/**
 * Infrastructure (#261 S28, #265, #267 S35): the application's paused executions and their pauses.
 *
 * - **The paused tree, by thread** (tenant + thread): the run as it rested and the workflow
 *   version / config hash it paused under (checked on resume).
 * - **Its pauses, by id**: one record per waiting step (its `step.idempotencyKey`), made before
 *   the channel is asked; a resume finds it by `(tenantId, pauseId)` anywhere in the tree and turns
 *   it from `Pending` to `Resolved` with its decision, atomically — of two concurrent resumes of
 *   one pause exactly one does (Q58).
 *
 * One per application, listed only in `@Application({ providers })`; the built-in default is in
 * memory. A pause survives a restart only when this repository and the checkpointer
 * (`BaseCheckpointSaver`) are both durable. Your own `extends PausedExecutionRepository`.
 */
export abstract class PausedExecutionRepository {
  /** The execution paused on the tenant's thread; `undefined` when none waits there. */
  abstract findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedRun | undefined>;

  /** Keeps a paused execution (one per thread of its `run.tenantId`: a later pause replaces it). */
  abstract save(paused: PausedRun): Promise<void>;

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
   * Atomic: turns the pause from `Pending` to `Resolved` with `resolution` and returns it;
   * `undefined` when it is not pending (another resume answered it, it was cancelled, or none).
   */
  abstract resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    resolution: PauseResolution,
  ): Promise<PauseRecord | undefined>;

  /** Atomic: turns the pause from `Pending` to `Cancelled`; `false` when it was not pending. */
  abstract cancelByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean>;

  /** Turns a `Resolved` pause to `Taken`: its step took the decision (the pass that ran it returned). */
  abstract markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void>;

  /** Forgets one pause (its channel decided at once: it never waited). */
  abstract deleteByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void>;
}

const pauseKeyOf = (tenantId: string, pauseId: string): string =>
  JSON.stringify([tenantId, pauseId]);

/**
 * The built-in default: paused executions in memory — another application instance cannot resume
 * them, and they are lost on restart. Every operation is one synchronous step, so it is atomic.
 */
@Injectable()
export class InMemoryPausedExecutionRepository extends PausedExecutionRepository {
  readonly #paused = new Map<string, PausedRun>();
  readonly #pauses = new Map<string, PauseRecord>();

  findByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<PausedRun | undefined> {
    return Promise.resolve(this.#paused.get(threadMapKeyOf({ tenantId, threadId })));
  }

  save(paused: PausedRun): Promise<void> {
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
    resolution: PauseResolution,
  ): Promise<PauseRecord | undefined> {
    return Promise.resolve(
      this.#transition(tenantId, pauseId, (pause) => resolvedPause(pause, resolution)),
    );
  }

  cancelByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<boolean> {
    const cancelled = this.#transition(tenantId, pauseId, (pause) => ({
      ...pause,
      status: PauseStatus.Cancelled,
    }));
    return Promise.resolve(cancelled !== undefined);
  }

  markTakenByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    const key = pauseKeyOf(tenantId, pauseId);
    const stored = this.#pauses.get(key);
    if (stored?.status === PauseStatus.Resolved)
      this.#pauses.set(key, { ...stored, status: PauseStatus.Taken });
    return Promise.resolve();
  }

  deleteByTenantIdAndPauseId(tenantId: string, pauseId: string): Promise<void> {
    this.#pauses.delete(pauseKeyOf(tenantId, pauseId));
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
