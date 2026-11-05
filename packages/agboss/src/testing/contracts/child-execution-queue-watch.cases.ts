import { expect } from "vitest";
import type {
  ChildExecutionQueueRepository,
  ChildExecutionQueueWatch,
} from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type { ContractCase } from "./define.js";
import { queuedChild as child } from "./queued-child.js";
import type { ContractInstances } from "./seam.js";

type Instances = ContractInstances<ChildExecutionQueueRepository>;

/** A wake-up to wait for: `next()` resolves at the watch's next call (the case's timeout bounds it). */
function wakeUps(): { readonly onQueued: () => void; next(): Promise<void> } {
  let woken: () => void = () => undefined;
  let pending = new Promise<void>((resolve) => (woken = resolve));
  return {
    onQueued: () => {
      woken();
    },
    next: async () => {
      await pending;
      pending = new Promise<void>((resolve) => (woken = resolve));
    },
  };
}

type WatchOf = (onQueued: () => void) => Promise<ChildExecutionQueueWatch>;

/** The store's `watchQueued`, bound; `undefined` for a store without one. */
const watchOf = (queue: ChildExecutionQueueRepository): WatchOf | undefined =>
  queue.watchQueued?.bind(queue);

/**
 * #777: a store's watch (`watchQueued`, optional) wakes an instance when any instance queues a
 * child — a new one or one queued again — and closes. A store without one is never woken (its
 * children queued elsewhere wait for the sweep): nothing to check of it.
 */
export const QUEUE_WATCH_CASES: readonly ContractCase<ChildExecutionQueueRepository>[] = [
  {
    name: "a child queued on another instance wakes the watch; it is claimed on the wake-up (#777)",
    run: async ({ first, second }: Instances): Promise<void> => {
      const watchQueued = watchOf(second);
      if (watchQueued === undefined) {
        expect(watchOf(first)).toBeUndefined();
        return;
      }
      const wake = wakeUps();
      const watch = await watchQueued(wake.onQueued);
      try {
        await first.saveIfAbsent(child("c-1"));
        await wake.next();
        expect(await second.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
          executionId: "c-1",
          instanceId: "instance-2",
        });

        // paused, then queued again on its resume: a wake-up too
        await second.completeByTenantIdAndExecutionId("default", "c-1", {
          status: ExecutionRecordStatus.Paused,
        });
        await first.saveIfAbsent(child("c-1", { run: '{"resume":{}}' }));
        await wake.next();
        expect(await second.claimFirstByStatusQueuedOrderByDepthDesc()).toMatchObject({
          executionId: "c-1",
          run: '{"resume":{}}',
        });
      } finally {
        await watch.close();
      }
    },
  },
  {
    name: "two watches of one instance are woken alike, and each closes on its own (#777)",
    run: async ({ first, second }: Instances): Promise<void> => {
      const watchQueued = watchOf(first);
      if (watchQueued === undefined) {
        expect(watchOf(second)).toBeUndefined();
        return;
      }
      const [one, two] = [wakeUps(), wakeUps()];
      const watches = [await watchQueued(one.onQueued), await watchQueued(two.onQueued)];
      await watches[0]?.close();

      await second.saveIfAbsent(child("c-1"));

      await two.next();
      await watches[1]?.close();
      expect(await first.findByTenantIdAndExecutionId("default", "c-1")).toMatchObject({
        status: ExecutionRecordStatus.Queued,
      });
    },
  },
];
