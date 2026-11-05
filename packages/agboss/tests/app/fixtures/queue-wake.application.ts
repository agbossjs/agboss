import {
  ApplicationContext,
  Clock,
  EmptyEnvironment,
  Injectable,
  type ChildExecutionQueueWatch,
  type QueuedChildExecution,
} from "../../../src/index.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ClaimRoomBatchWorkflow, ClaimRoomItemWorkflow } from "./claim-room.workflow.js";

/**
 * #777 — a child queued by another process: the in-memory queue as a networked store looks to an
 * instance whose claims cannot see a row another process has not committed yet. While
 * `wakeLog.isHidden`, every claim answers nothing (the row is queued, this instance does not see
 * it), so the in-process hint finds nothing; the store's watch is the test's — `wake()` is the
 * notification, leaving it out is a notification lost.
 */

/** The watch's listeners, the claims asked and what the next opens do. */
export const wakeLog = {
  listeners: new Set<() => void>(),
  isHidden: false,
  claims: 0,
  opened: 0,
  closed: 0,
  /** How many of the next opens reject. */
  failingOpens: 0,
};

export function resetWakeLog(): void {
  wakeLog.listeners.clear();
  wakeLog.isHidden = false;
  wakeLog.claims = 0;
  wakeLog.opened = 0;
  wakeLog.closed = 0;
  wakeLog.failingOpens = 0;
}

/** The store's notification: every open watch wakes its claimer. */
export function wake(): void {
  for (const listener of [...wakeLog.listeners]) listener();
}

/** The in-memory queue with a watch the test drives and claims it can hide. */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class WakeTestQueueRepository extends InMemoryChildExecutionQueueRepository {
  override claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    wakeLog.claims += 1;
    if (wakeLog.isHidden) return Promise.resolve(undefined);
    return super.claimFirstByStatusQueuedOrderByDepthDesc();
  }

  override watchQueued(onQueued: () => void): Promise<ChildExecutionQueueWatch> {
    if (wakeLog.failingOpens > 0) {
      wakeLog.failingOpens -= 1;
      return Promise.reject(new Error("the listening connection was refused"));
    }
    wakeLog.opened += 1;
    wakeLog.listeners.add(onQueued);
    return Promise.resolve({
      close: () => {
        wakeLog.closed += 1;
        wakeLog.listeners.delete(onQueued);
        return Promise.resolve();
      },
    });
  }
}

/** The claim-room workflows on the waking queue: three steps at a time. */
@Application({
  name: "queue-wake-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClaimRoomBatchWorkflow, ClaimRoomItemWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 3,
  providers: [WakeTestQueueRepository, RecordingLogger],
})
export class QueueWakeApplication {}
