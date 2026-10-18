import { Injectable } from "../components/decorators.js";
import type { PausedRun } from "../app/paused-runs.js";

/**
 * Infrastructure (#261, S28): the paused executions by thread — what `app.resume(thread, …)`
 * continues. One per application, listed only in `@Application({ providers })`; the built-in
 * default is in memory. A pause survives a restart only when this repository and the checkpointer
 * (`BaseCheckpointSaver`) are both durable. Your own `extends PausedExecutionRepository`.
 */
export abstract class PausedExecutionRepository {
  /** The execution paused on `threadId`; `undefined` when none waits there. */
  abstract findByThreadId(threadId: string): Promise<PausedRun | undefined>;

  /** Keeps a paused execution (one per thread: a later pause replaces it). */
  abstract save(paused: PausedRun): Promise<void>;

  /** Forgets the thread's paused execution (it was resumed to its end, or cancelled). */
  abstract deleteByThreadId(threadId: string): Promise<void>;
}

/**
 * The built-in default: paused executions in memory — another application instance cannot resume
 * them, and they are lost on restart.
 */
@Injectable()
export class InMemoryPausedExecutionRepository extends PausedExecutionRepository {
  readonly #paused = new Map<string, PausedRun>();

  findByThreadId(threadId: string): Promise<PausedRun | undefined> {
    return Promise.resolve(this.#paused.get(threadId));
  }

  save(paused: PausedRun): Promise<void> {
    this.#paused.set(paused.run.threadId, paused);
    return Promise.resolve();
  }

  deleteByThreadId(threadId: string): Promise<void> {
    this.#paused.delete(threadId);
    return Promise.resolve();
  }
}
