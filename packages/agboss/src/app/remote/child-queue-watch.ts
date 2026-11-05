import type {
  ChildExecutionQueueRepository,
  ChildExecutionQueueWatch,
} from "../../infrastructure/child-execution-queue.repository.js";
import type { FrameworkLog } from "../../infrastructure/logger.js";

/**
 * The child queue's watch of one instance's claimers (#777): opened before the sweep's first look,
 * so that a child queued in another process after that look wakes the claimer instead of waiting
 * for the next sweep; tried again at each sweep while it rejects; closed once, when the claimers
 * stop. A store without `watchQueued` has none — the sweep and the in-process hint claim alone.
 */
export class ChildQueueWatch {
  /** `undefined` before it opened, `null` for a store with none or once closed. */
  #watch: ChildExecutionQueueWatch | null | undefined;

  constructor(
    private readonly queue: ChildExecutionQueueRepository,
    private readonly onQueued: () => void,
    private readonly log: FrameworkLog,
  ) {}

  /** Opens the watch unless it is open: called before each sweep's look. */
  async open(): Promise<void> {
    if (this.#watch !== undefined) return;
    if (this.queue.watchQueued === undefined) {
      this.#watch = null;
      return;
    }
    try {
      this.#watch = await this.queue.watchQueued(this.onQueued);
    } catch (error) {
      this.#warn(
        `the child queue's watch did not open (children queued elsewhere are claimed at the sweep): ${String(error)}`,
      );
    }
  }

  /** Closes the watch for good. */
  async close(): Promise<void> {
    const watch = this.#watch;
    this.#watch = null;
    try {
      await watch?.close();
    } catch (error) {
      this.#warn(`the child queue's watch did not close: ${String(error)}`);
    }
  }

  #warn(text: string): void {
    this.log.warn("child-queue.watch-failed", text, {});
  }
}
