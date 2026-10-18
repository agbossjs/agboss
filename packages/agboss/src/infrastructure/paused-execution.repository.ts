import { Injectable } from "../components/decorators.js";
import type { PausedRun } from "../app/paused-runs.js";

/** Where a pause is (#265, Q58): waiting for its decision, or answered and not yet continued. */
export enum PauseStatus {
  /** Waiting for its decision. */
  Pending = "pending",
  /** A resume recorded its decision; the tree's lease holder continues it. */
  Resolved = "resolved",
}

/**
 * Infrastructure (#261, S28): the paused executions by thread — keyed by tenant + thread (#261),
 * what `app.resume(threadId, …, { tenantId })`
 * continues. A resume first turns the pause from `Pending` to `Resolved` together with its
 * decision, atomically (#265, Q58: of two concurrent resumes exactly one does), then continues
 * the tree under its lease. One per application, listed only in `@Application({ providers })`;
 * the built-in default is in memory. A pause survives a restart only when this repository and the
 * checkpointer (`BaseCheckpointSaver`) are both durable. Your own `extends PausedExecutionRepository`.
 */
export abstract class PausedExecutionRepository {
  /** The execution paused on the tenant's thread; `undefined` when none waits there. */
  abstract findByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
  ): Promise<PausedRun | undefined>;

  /** Keeps a paused execution (one per thread of its `run.tenantId`: a later pause replaces it). */
  abstract save(paused: PausedRun): Promise<void>;

  /**
   * Atomic: turns the thread's `Pending` pause to `Resolved` with `decision` and returns it;
   * `undefined` when none is pending (none waits, or another resume already answered it).
   */
  abstract resolveByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
    decision: unknown,
  ): Promise<PausedRun | undefined>;

  /** Forgets the thread's paused execution (it was resumed to its end, or cancelled). */
  abstract deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void>;
}

/** The pause answered: `Resolved` with its decision. */
export const resolvedPause = (paused: PausedRun, decision: unknown): PausedRun => ({
  ...paused,
  status: PauseStatus.Resolved,
  decision,
});

/**
 * The built-in default: paused executions in memory — another application instance cannot resume
 * them, and they are lost on restart. Every operation is one synchronous step, so it is atomic.
 */
@Injectable()
export class InMemoryPausedExecutionRepository extends PausedExecutionRepository {
  readonly #paused = new Map<string, PausedRun>();

  findByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<PausedRun | undefined> {
    return Promise.resolve(this.#paused.get(threadKeyOf(tenantId, threadId)));
  }

  save(paused: PausedRun): Promise<void> {
    this.#paused.set(threadKeyOf(paused.run.tenantId, paused.run.threadId), paused);
    return Promise.resolve();
  }

  resolveByTenantIdAndThreadId(
    tenantId: string,
    threadId: string,
    decision: unknown,
  ): Promise<PausedRun | undefined> {
    const key = threadKeyOf(tenantId, threadId);
    const stored = this.#paused.get(key);
    if (stored?.status !== PauseStatus.Pending) return Promise.resolve(undefined);
    const resolved = resolvedPause(stored, decision);
    this.#paused.set(key, resolved);
    return Promise.resolve(resolved);
  }

  deleteByTenantIdAndThreadId(tenantId: string, threadId: string): Promise<void> {
    this.#paused.delete(threadKeyOf(tenantId, threadId));
    return Promise.resolve();
  }
}

/** One string per thread of a tenant: the same id in two tenants is two threads (#261). */
const threadKeyOf = (tenantId: string, threadId: string): string =>
  JSON.stringify([tenantId, threadId]);
