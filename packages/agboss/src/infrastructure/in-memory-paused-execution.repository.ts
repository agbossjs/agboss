import { Injectable } from "../components/decorators.js";
import { lazyLoad } from "./clock.js";
import { LazyPausedExecutionRepository } from "./lazy-paused-execution.repository.js";
import type { PausedExecutionRepository } from "./paused-execution.repository.js";

/**
 * The built-in default: paused executions in memory — another application instance cannot resume
 * them, and they are lost on restart. Every operation is one synchronous step of the store behind
 * it (`in-memory-pause-store.ts`), so it is atomic.
 */
@Injectable()
export class InMemoryPausedExecutionRepository extends LazyPausedExecutionRepository {
  ping(): Promise<void> {
    return Promise.resolve();
  }

  protected loadStore(): Promise<PausedExecutionRepository> {
    return lazyLoad(import("./in-memory-pause-store.js")).then(
      ({ InMemoryPauseStore }) => new InMemoryPauseStore(),
    );
  }
}
