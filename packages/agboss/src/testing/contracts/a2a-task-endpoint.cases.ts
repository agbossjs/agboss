import { expect } from "vitest";
import type { A2ATaskRepository } from "../../infrastructure/a2a-task.repository.js";
import {
  A2ATaskSaveStatus,
  type A2AMessageRecord,
} from "../../infrastructure/a2a-task.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  at,
  COMPLETED,
  cutoffsOf,
  ENDPOINT,
  ids,
  keyOf,
  messageKeyOf,
  newTask,
  saved,
  savedMany,
  WORKING,
} from "./a2a-task-data.js";

type Instances = ContractInstances<A2ATaskRepository>;

/** A follow-up message of alice's, of `ENDPOINT`, for a task. */
const followUp = (messageId: string, taskId: string, savedAt: Date): A2AMessageRecord => ({
  endpoint: ENDPOINT,
  tenantId: "default",
  ownerId: "alice",
  messageId,
  requestHash: "h-9",
  taskId,
  savedAt,
});

/** The sweep of finished tasks (#807). */
export const A2A_TASK_SWEEP_CASES: readonly ContractCase<A2ATaskRepository>[] = [
  {
    name: "the sweep removes terminal tasks older than its cutoff, with their messages; never an unfinished one",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMany(first, 3);
      const key = (n: number) => ({ tenantId: "default", taskId: `t-${String(n)}` });
      // t-1 completed at 9:05, t-2 completed at 9:30, t-3 still working since 9:00
      await first.compareAndSetStatus(key(1), 1, COMPLETED, at(5));
      await first.compareAndSetStatus(key(2), 1, COMPLETED, at(30));
      await first.compareAndSetStatus(key(3), 1, WORKING, at(4));

      await second.deleteExpired(cutoffsOf(at(20)));
      // a task that ended at the cutoff itself is kept
      await second.deleteExpired(cutoffsOf(at(30)));

      expect(await first.findById(key(1))).toBeUndefined();
      expect(await first.findById(key(2))).toBeDefined();
      expect(await first.findById(key(3))).toBeDefined();
      expect(await first.findByMessage(messageKeyOf(newTask("t-1")))).toBeUndefined();
      expect(await first.findByMessage(messageKeyOf(newTask("t-3")))).toBeDefined();
      // past its retention a message id is a new message
      const resent = await second.saveIfAbsent(newTask("t-1b", { messageId: "m-t-1" }));
      expect(resent.status).toBe(A2ATaskSaveStatus.Saved);
    },
  },
];

/**
 * #1320: the rows of one endpoint are its own — listed, swept at its own cutoff (an endpoint with
 * no cutoff is never swept), by whichever instance sweeps.
 */
export const A2A_TASK_ENDPOINT_CASES: readonly ContractCase<A2ATaskRepository>[] = [
  {
    name: "a list reads one endpoint's tasks: two endpoints on one store never see each other's",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1", { acceptedAt: at(1) }));
      await saved(first, newTask("t-2", { endpoint: "support", acceptedAt: at(2) }));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 10 };

      const billing = await second.list({ ...query, endpoint: ENDPOINT });
      const support = await second.list({ ...query, endpoint: "support" });
      const other = await second.list({ ...query, endpoint: "nobody" });

      expect([ids(billing.tasks), billing.totalSize]).toEqual([["t-1"], 1]);
      expect([ids(support.tasks), support.totalSize]).toEqual([["t-2"], 1]);
      expect(other).toEqual({ tasks: [], nextPageToken: "", totalSize: 0 });
    },
  },
  {
    name: "each endpoint is swept at its own cutoff: a task of another endpoint, or of none listed, stays",
    run: async ({ first, second }: Instances): Promise<void> => {
      const support = newTask("t-2", { endpoint: "support" });
      await saved(first, newTask("t-1"));
      await saved(first, support);
      await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, COMPLETED, at(5));
      await first.compareAndSetStatus(keyOf(support), 1, COMPLETED, at(5));

      const removed = await second.deleteExpired(new Map([[ENDPOINT, at(10)]]));

      expect(removed).toBe(1);
      expect(await first.findById(keyOf(newTask("t-1")))).toBeUndefined();
      expect(await first.findById(keyOf(support))).toBeDefined();
      expect(await first.findByMessage(messageKeyOf(support))).toBeDefined();
      const both = new Map([
        [ENDPOINT, at(10)],
        ["support", at(4)],
      ]);
      expect(await second.deleteExpired(both)).toBe(0);
      expect(await second.deleteExpired(new Map([["support", at(10)]]))).toBe(1);
      expect(await first.findById(keyOf(support))).toBeUndefined();
    },
  },
  {
    name: "an unfinished task is never swept, whatever its endpoint's cutoff; an empty map sweeps nothing",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));
      await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, WORKING, at(1));
      await saved(first, newTask("t-2"));
      await first.compareAndSetStatus(keyOf(newTask("t-2")), 1, COMPLETED, at(1));

      expect(await second.deleteExpired(new Map())).toBe(0);
      expect(await second.deleteExpired(cutoffsOf(at(600)))).toBe(1);

      expect(await first.findById(keyOf(newTask("t-1")))).toBeDefined();
      expect(await first.findById(keyOf(newTask("t-2")))).toBeUndefined();
    },
  },
  {
    name: "a message of another endpoint, orphaned or not, is swept by its own endpoint's cutoff only",
    run: async ({ first, second }: Instances): Promise<void> => {
      const orphan = { ...followUp("m-late", "t-gone", at(3)), endpoint: "support" };
      expect(await first.saveMessageIfAbsent(orphan)).toBeUndefined();

      await second.deleteExpired(cutoffsOf(at(60)));
      expect(await first.findByMessage(orphan)).toBeDefined();

      await second.deleteExpired(new Map([["support", at(60)]]));
      expect(await first.findByMessage(orphan)).toBeUndefined();
    },
  },
];
