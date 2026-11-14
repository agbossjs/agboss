import type { FrameworkLog } from "../infrastructure/logger.js";
import type { StoreOutcomeUnknownError } from "../infrastructure/store-call-timeout.js";

/**
 * A held lease abandoned (#928): a store call under it did not answer, so its holder stopped as at
 * the lease's expiry and gives nothing back — the lease expires in its store, and only then is the
 * tree taken over. The first cause stays; the hand-over runs once, whoever asks again waits for it.
 */
export class Abandonment {
  #cause: StoreOutcomeUnknownError | undefined;
  #done: Promise<void> | undefined;

  /** Why it was abandoned; `undefined` while it is not. */
  get cause(): StoreOutcomeUnknownError | undefined {
    return this.#cause;
  }

  /** At a release: says `execution.lease-abandoned` and gives `true` when it was abandoned. */
  told(log: FrameworkLog | undefined, lease: AbandonedLease): boolean {
    if (this.#cause !== undefined) tellAbandoned(log, lease, this.#cause);
    return this.#cause !== undefined;
  }

  /** Abandons with `work` once; a second call gets the same end. */
  run(cause: StoreOutcomeUnknownError, work: () => Promise<void>): Promise<void> {
    this.#cause ??= cause;
    this.#done ??= work();
    return this.#done;
  }
}

/** What an abandoned lease is told by: its execution, tenant and token. */
export interface AbandonedLease {
  readonly executionId: string;
  readonly tenantId: string;
  readonly token?: number | undefined;
}

/** What a release of an abandoned lease says: nothing was given back (`execution.lease-abandoned`). */
function tellAbandoned(
  log: FrameworkLog | undefined,
  lease: AbandonedLease,
  cause: StoreOutcomeUnknownError,
): void {
  const { executionId, tenantId, token } = lease;
  const text = `the lease of execution ${executionId} (token ${String(token)}) was abandoned: ${cause.store}.${cause.operation} did not answer — nothing is released, the lease expires in its store and the next take of it reconciles`;
  log?.warn("execution.lease-abandoned", text, { executionId, tenantId });
}
