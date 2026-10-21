import { IdGenerator } from "../infrastructure/clock.js";

/**
 * The ids of a test (#313): `thread-1`, `thread-2`, … and `execution-1`, `execution-2`, … in the
 * order they are made, counted from 1 in each test. `testWith` gives one per test, shared by its
 * instances (`instances: 2`, `recoverApp()`), unless the application lists its own `IdGenerator`.
 * Deterministic, so never for production: two processes would make the same ids.
 */
export class SequentialIdGenerator extends IdGenerator {
  #threads = 0;
  #executions = 0;

  /** `thread-1`, `thread-2`, … */
  newThreadId(): string {
    this.#threads += 1;
    return `thread-${String(this.#threads)}`;
  }

  /** `execution-1`, `execution-2`, … */
  newExecutionId(): string {
    this.#executions += 1;
    return `execution-${String(this.#executions)}`;
  }
}
