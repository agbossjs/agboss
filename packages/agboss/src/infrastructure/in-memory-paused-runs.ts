import type { PausedExecution } from "../app/paused-runs.js";
import { threadMapKeyOf } from "./in-memory-database.js";
import { PausedExecutionRepository } from "./paused-execution.repository.js";

/**
 * The paused runs of the in-memory store (one per thread of a tenant): its first layer; the pauses
 * and their notices are the layers above.
 */
export abstract class InMemoryPausedRunRepository extends PausedExecutionRepository {
  readonly #paused = new Map<string, PausedExecution>();

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

  deleteByTenantIdAndThreadIdAndRunId(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<void> {
    const key = threadMapKeyOf({ tenantId, threadId });
    if (this.#paused.get(key)?.run.runId === runId) this.#paused.delete(key);
    return Promise.resolve();
  }
}
