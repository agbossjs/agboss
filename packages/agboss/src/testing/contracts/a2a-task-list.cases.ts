import { expect } from "vitest";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  InvalidA2APageTokenError,
  type A2ATaskRepository,
} from "../../infrastructure/a2a-task.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  at,
  WORKING,
  COMPLETED,
  newTask,
  messageKeyOf,
  saved,
  savedMany,
  ids,
} from "./a2a-task-data.js";

type Instances = ContractInstances<A2ATaskRepository>;

export const A2A_TASK_LIST_CASES: readonly ContractCase<A2ATaskRepository>[] = [
  {
    name: "a caller's tasks, the newest status first; one written later moves to the front",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMany(first, 3);
      await saved(first, newTask("t-bob", { ownerId: "bob", acceptedAt: at(9) }));
      await first.compareAndSetStatus({ tenantId: "default", taskId: "t-1" }, 1, WORKING, at(5));

      const page = await second.list({ tenantId: "default", ownerId: "alice", pageSize: 10 });

      expect(ids(page.tasks)).toEqual(["t-1", "t-3", "t-2"]);
      expect(page.nextPageToken).toBe("");
    },
  },
  {
    name: "ties of status time are ordered by task id, descending",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const id of ["t-b", "t-c", "t-a"]) await saved(first, newTask(id));

      const page = await second.list({ tenantId: "default", ownerId: "alice", pageSize: 10 });

      expect(ids(page.tasks)).toEqual(["t-c", "t-b", "t-a"]);
    },
  },
  {
    name: "pages follow each other with no task twice or left out; the last page's token is empty",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMany(first, 5);
      for (const id of ["t-6", "t-7"]) await saved(first, newTask(id, { acceptedAt: at(5) }));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 3 };

      const one = await second.list(query);
      const two = await second.list({ ...query, pageToken: one.nextPageToken });
      const three = await first.list({ ...query, pageToken: two.nextPageToken });

      expect([ids(one.tasks), ids(two.tasks), ids(three.tasks)]).toEqual([
        ["t-7", "t-6", "t-5"],
        ["t-4", "t-3", "t-2"],
        ["t-1"],
      ]);
      expect(one.nextPageToken).not.toBe("");
      expect(three.nextPageToken).toBe("");
      const exact = await second.list({ ...query, pageSize: 7 });
      expect(exact.tasks).toHaveLength(7);
      expect(exact.nextPageToken).toBe("");
    },
  },
  {
    name: "a page that ends inside a tie of status time goes on after its last task",
    run: async ({ first, second }: Instances): Promise<void> => {
      // saved in no order, all accepted at nine: one tie of five
      for (const id of ["t-c", "t-a", "t-e", "t-b", "t-d"]) await saved(first, newTask(id));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 2 };

      const one = await second.list(query);
      const two = await second.list({ ...query, pageToken: one.nextPageToken });
      const three = await first.list({ ...query, pageToken: two.nextPageToken });

      expect([ids(one.tasks), ids(two.tasks), ids(three.tasks)]).toEqual([
        ["t-e", "t-d"],
        ["t-c", "t-b"],
        ["t-a"],
      ]);
      expect(three.nextPageToken).toBe("");
    },
  },
  {
    name: "the next page never gives again a newer task whose id sorts lower",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-b", { acceptedAt: at(9) }));
      await saved(first, newTask("t-c", { acceptedAt: at(8) }));
      await saved(first, newTask("t-a", { acceptedAt: at(7) }));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 2 };

      const one = await second.list(query);
      const two = await first.list({ ...query, pageToken: one.nextPageToken });

      expect([ids(one.tasks), ids(two.tasks)]).toEqual([["t-b", "t-c"], ["t-a"]]);
    },
  },
  {
    name: "a caller with no task gets an empty last page",
    run: async ({ first }: Instances): Promise<void> => {
      expect(await first.list({ tenantId: "default", ownerId: "alice", pageSize: 3 })).toEqual({
        tasks: [],
        nextPageToken: "",
        totalSize: 0,
      });
    },
  },
  {
    name: "totalSize counts every task the query matches, before paging: the same on every page",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMany(first, 5);
      await saved(first, newTask("t-bob", { ownerId: "bob", acceptedAt: at(9) }));
      await saved(first, newTask("t-other", { contextId: "ctx-b", acceptedAt: at(8) }));
      await first.compareAndSetStatus({ tenantId: "default", taskId: "t-2" }, 1, WORKING, at(6));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 2 };

      const one = await second.list(query);
      const two = await first.list({ ...query, pageToken: one.nextPageToken });
      const last = await second.list({ ...query, pageToken: "", pageSize: 100 });
      const inContext = await first.list({ ...query, contextId: "ctx-1" });
      const working = await second.list({ ...query, state: A2ATaskState.Working });

      expect([one.totalSize, two.totalSize, last.totalSize]).toEqual([6, 6, 6]);
      expect(ids(one.tasks)).toHaveLength(2);
      expect(inContext.totalSize).toBe(5);
      expect([working.totalSize, ids(working.tasks)]).toEqual([1, ["t-2"]]);
    },
  },
  {
    name: "statusAtAfter keeps the tasks whose status changed strictly after it, page by page, and totalSize counts them",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMany(first, 4);
      // t-1 written at 9:10 is newer than the cutoff again
      await first.compareAndSetStatus({ tenantId: "default", taskId: "t-1" }, 1, WORKING, at(10));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 2, statusAtAfter: at(2) };

      const one = await second.list(query);
      const two = await first.list({ ...query, pageToken: one.nextPageToken });

      expect([ids(one.tasks), ids(two.tasks)]).toEqual([["t-1", "t-4"], ["t-3"]]);
      expect(two.nextPageToken).toBe("");
      expect([one.totalSize, two.totalSize]).toEqual([3, 3]);
      // a cutoff at a task's own status time leaves it out; one past every task leaves none
      expect(ids((await second.list({ ...query, statusAtAfter: at(3) })).tasks)).toEqual([
        "t-1",
        "t-4",
      ]);
      expect(await first.list({ ...query, statusAtAfter: at(10) })).toEqual({
        tasks: [],
        nextPageToken: "",
        totalSize: 0,
      });
    },
  },
  {
    name: "filters by context and by state; no owner lists the tasks of no owner only",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1", { contextId: "ctx-a" }));
      await saved(first, newTask("t-2", { contextId: "ctx-b", acceptedAt: at(1) }));
      await saved(first, newTask("t-3", { ownerId: undefined, acceptedAt: at(2) }));
      await first.compareAndSetStatus({ tenantId: "default", taskId: "t-2" }, 1, WORKING, at(3));
      const alice = { tenantId: "default", ownerId: "alice", pageSize: 10 };

      const byContext = await second.list({ ...alice, contextId: "ctx-a" });
      const byState = await second.list({ ...alice, state: A2ATaskState.Working });
      const nobody = await second.list({ ...alice, ownerId: undefined });

      expect(ids(byContext.tasks)).toEqual(["t-1"]);
      expect(ids(byState.tasks)).toEqual(["t-2"]);
      expect(ids(nobody.tasks)).toEqual(["t-3"]);
      expect(ids((await second.list({ ...alice, tenantId: "acme" })).tasks)).toEqual([]);
    },
  },
  {
    name: "a page token no list gave is refused",
    run: async ({ first }: Instances): Promise<void> => {
      const query = { tenantId: "default", ownerId: "alice", pageSize: 10 };
      const forged = [
        "not a token",
        Buffer.from("[1]").toString("base64url"),
        Buffer.from('["x","t"]').toString("base64url"),
      ];

      for (const pageToken of forged)
        await expect(first.list({ ...query, pageToken })).rejects.toBeInstanceOf(
          InvalidA2APageTokenError,
        );
    },
  },
];

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

      await second.deleteTerminalByStatusAtBefore(at(20));
      // a task that ended at the cutoff itself is kept
      await second.deleteTerminalByStatusAtBefore(at(30));

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
