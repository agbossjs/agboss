import { expect } from "vitest";
import type {
  ChildExecutionEnd,
  ChildExecutionQueueDepth,
  ChildExecutionQueueRepository,
} from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";
import { queuedChild as child } from "./queued-child.js";

/**
 * #485: `findQueueDepth()` — the cluster's queued work, what every instance reports as
 * `agboss.cluster.children.*`: the `Queued` and `Running` rows of every tenant and tree, and the
 * oldest still queued.
 */

type Instances = ContractInstances<ChildExecutionQueueRepository>;

const at = (seconds: number): Date => new Date(Date.UTC(2026, 0, 5, 9, 0, seconds));

const EMPTY: ChildExecutionQueueDepth = { queued: 0, running: 0, oldestQueuedAt: undefined };

const depthOf = async (queue: ChildExecutionQueueRepository): Promise<ChildExecutionQueueDepth> => {
  const { queued, running, oldestQueuedAt } = await queue.findQueueDepth();
  return { queued, running, oldestQueuedAt };
};

const claim = (queue: ChildExecutionQueueRepository) =>
  queue.claimFirstByStatusQueuedOrderByDepthDesc();

/** Saves `count` children `c-<from>` … queued a second apart from `at(from)`. */
async function saveMany(
  queue: ChildExecutionQueueRepository,
  count: number,
  from = 0,
): Promise<void> {
  for (let index = from; index < from + count; index += 1)
    await queue.saveIfAbsent(child(`c-${String(index)}`, { queuedAt: at(index) }));
}

export const QUEUE_DEPTH_CASES: readonly ContractCase<ChildExecutionQueueRepository>[] = [
  {
    name: "depth (#485): an empty queue is 0 queued, 0 running, no oldest",
    run: async ({ first }: Instances): Promise<void> => {
      expect(await depthOf(first)).toEqual(EMPTY);
    },
  },
  {
    name: "depth (#485): queued and running rows of every tenant and tree, the same on both instances",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", { queuedAt: at(3) }));
      await first.saveIfAbsent(child("c-2", { tenantId: "acme", queuedAt: at(2) }));
      await second.saveIfAbsent(child("c-3", { rootExecutionId: "root-2", queuedAt: at(4) }));
      await second.saveIfAbsent(child("c-4", { depth: 5, queuedAt: at(9) }));
      await claim(second); // the deepest: c-4

      const expected = { queued: 3, running: 1, oldestQueuedAt: at(2) };
      expect(await depthOf(first)).toEqual(expected);
      expect(await depthOf(second)).toEqual(expected);
    },
  },
  {
    name: "depth (#485): ended and paused children are not counted",
    run: async ({ first }: Instances): Promise<void> => {
      await saveMany(first, 4);
      for (let index = 0; index < 3; index += 1) await claim(first);
      const end = (executionId: string, status: ChildExecutionEnd["status"]) =>
        first.completeByTenantIdAndExecutionId("default", executionId, { status });
      await end("c-0", ExecutionRecordStatus.Answered);
      await end("c-1", ExecutionRecordStatus.Failed);
      await end("c-2", ExecutionRecordStatus.Paused);

      expect(await depthOf(first)).toEqual({ queued: 1, running: 0, oldestQueuedAt: at(3) });
    },
  },
  {
    name: "depth (#485): the oldest is the oldest still queued — a claim moves it",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saveMany(first, 3, 1);

      expect((await depthOf(second)).oldestQueuedAt).toEqual(at(1));
      await claim(second);
      expect(await depthOf(first)).toEqual({ queued: 2, running: 1, oldestQueuedAt: at(2) });
      await claim(first);
      await claim(second);
      expect(await depthOf(first)).toEqual({ queued: 0, running: 3, oldestQueuedAt: undefined });
    },
  },
  {
    name: "depth (#485): a deeper, newer child claimed first leaves the oldest queued",
    run: async ({ first }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("old", { queuedAt: at(1) }));
      await first.saveIfAbsent(child("deep", { depth: 4, queuedAt: at(8) }));
      await claim(first);

      expect(await depthOf(first)).toEqual({ queued: 1, running: 1, oldestQueuedAt: at(1) });
    },
  },
  {
    name: "depth (#485): a tree's rows go with its root; a lost claim queued again counts as queued",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.saveIfAbsent(child("c-1", { rootExecutionId: "root-2", queuedAt: at(1) }));
      await first.saveIfAbsent(child("c-2", { queuedAt: at(2) }));
      await second.deleteAllByTenantIdAndRootExecutionId("default", "root-2");
      const claimed = await claim(first);
      expect(await depthOf(second)).toEqual({ queued: 0, running: 1, oldestQueuedAt: undefined });

      await second.saveIfAbsent({ ...child("c-2", { queuedAt: at(7) }), ...pick(claimed) });

      expect(await depthOf(first)).toEqual({ queued: 1, running: 0, oldestQueuedAt: at(7) });
    },
  },
  {
    name: "depth (#485): 40 children claimed by both instances at once — every row counted once",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saveMany(first, 40);

      const claims = await Promise.all(
        Array.from({ length: 24 }, (_, index) => claim(index % 2 === 0 ? first : second)),
      );

      const won = claims.filter((found) => found !== undefined).length;
      expect(won).toBe(24);
      expect(await depthOf(second)).toEqual({ queued: 16, running: 24, oldestQueuedAt: at(24) });
    },
  },
];

/** The claim a re-queue names: its `claimedAt`. */
const pick = (claimed: { readonly claimedAt?: Date | undefined } | undefined) => ({
  claimedAt: claimed?.claimedAt,
});
