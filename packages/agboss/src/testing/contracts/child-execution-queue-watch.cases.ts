import { expect } from "vitest";
import type {
  ChildExecutionQueueRepository,
  ChildExecutionQueueWatch,
} from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type { CapabilityCheck, ContractCase } from "./define.js";
import { queuedChild as child } from "./queued-child.js";
import type { ContractInstances } from "./instance-context.js";
import { StoreCapability } from "./store-capability.js";

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

/** The store's `watchQueued`, bound: the case runs only on a store that has one (`WATCH`). */
const watchOf = (queue: ChildExecutionQueueRepository): WatchOf => {
  if (queue.watchQueued === undefined) throw new Error("the store has no watchQueued");
  return queue.watchQueued.bind(queue);
};

/**
 * `watchQueued` is optional (#831): its cases run when the store declares
 * `StoreCapability.WatchQueued`, and are skipped, with this reason, for one that does not.
 */
const WATCH: CapabilityCheck<ChildExecutionQueueRepository> = {
  capability: StoreCapability.WatchQueued,
  isPresent: (queue) => queue.watchQueued !== undefined,
  without: "a child queued on another instance waits for the sweep (#777)",
};

/**
 * #777: a store's watch (`watchQueued`, optional) wakes an instance when any instance queues a
 * child — a new one or one queued again — and closes. A store without one is never woken (its
 * children queued elsewhere wait for the sweep): its cases are skipped, never passed (#799) — what
 * the store declares decides (#831: `capabilities: [StoreCapability.WatchQueued]`).
 */
export const QUEUE_WATCH_CASES: readonly ContractCase<ChildExecutionQueueRepository>[] = [
  {
    name: "a child queued on another instance wakes the watch; it is claimed on the wake-up (#777)",
    capability: WATCH,
    run: async ({ first, second }: Instances): Promise<void> => {
      const watchQueued = watchOf(second);
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
    capability: WATCH,
    run: async ({ first, second }: Instances): Promise<void> => {
      const watchQueued = watchOf(first);
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
