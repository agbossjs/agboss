import type {
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import { remoteChildSignals } from "../../flow/runtime/remote/remote-child-signals.js";
import { leaseReleases } from "../lease-releases.js";
import { isSameRunningClaim } from "./child-registry.js";
import { seconds, type Milliseconds } from "../../units/index.js";

/**
 * How long a worker waits before it looks at the queue again after a refused lease take (#923): the
 * child's lease is another live worker's, so a look at once finds the same row again — and every
 * re-queue wakes the other instances, which refuse and re-queue in turn.
 */
const REFUSED_BACKOFF: Milliseconds = seconds(1);

/**
 * The pace of one worker's looks at the queue: after a refused take, a look waits `REFUSED_BACKOFF`
 * on the `Clock` — or until the refused tree's lease is released in this process, whichever comes
 * first (a wake-up within it is held until then, never dropped); the sweep stays the safety net.
 */
export class LookPacing {
  #holdOff: Promise<void> | undefined;
  #deferred: Promise<void> | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly stopped: AbortSignal,
  ) {}

  /** The take of the lease of tree `key` was refused: no look before the backoff has passed. */
  refused(key: string): void {
    if (this.#holdOff !== undefined) return;
    const watch = leaseReleases.watch(key);
    this.#holdOff = watch
      .wait((waiting) => this.clock.sleep(REFUSED_BACKOFF, waiting), this.stopped)
      .finally(() => {
        watch.close();
        this.#holdOff = undefined;
      });
  }

  /**
   * Within the backoff: the look to wait for — `look` once it has passed, one for every look asked
   * meanwhile. `undefined` when a look may run now.
   */
  deferred(look: () => Promise<void>): Promise<void> | undefined {
    if (this.#holdOff === undefined) return undefined;
    this.#deferred ??= this.#holdOff.then(() => {
      this.#deferred = undefined;
      return this.stopped.aborted ? undefined : look();
    });
    return this.#deferred;
  }
}

/**
 * Puts a claim whose lease was not free back in the queue — only while the row is still this
 * claim (#520): a child another worker ended, paused or claimed meanwhile, or one whose tree ended,
 * stays as it is. A read that fails puts it back (the queue refuses anything but this claim). The
 * other instances of this process look at once; this worker's own next look is paced.
 */
export async function requeueIfStillClaimed(
  queue: ChildExecutionQueueRepository,
  row: QueuedChildExecution,
  own: () => void,
): Promise<void> {
  const current = await queue
    .findByTenantIdAndExecutionId(row.tenantId, row.executionId)
    .catch(() => row);
  if (!isSameRunningClaim(current, row)) return;
  await queue.saveIfAbsent({ ...row, status: ExecutionRecordStatus.Queued });
  remoteChildSignals.queued(own);
}
