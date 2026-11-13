import { Injectable } from "../components/decorators.js";
import { InMemoryPauseStore } from "./in-memory-pause-store.js";

/**
 * The built-in default: paused executions in memory — another application instance cannot resume
 * them, and they are lost on restart. Every operation is one synchronous step of the store behind
 * it (`in-memory-pause-store.ts`), so it is atomic.
 */
@Injectable()
export class InMemoryPausedExecutionRepository extends InMemoryPauseStore {
  override ping(): Promise<void> {
    return Promise.resolve();
  }
}
