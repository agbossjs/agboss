import { expect } from "vitest";
import {
  A2ATaskSaveStatus,
  type A2AMessageRecord,
  type A2ATaskRecord,
  type A2ATaskRepository,
} from "../../infrastructure/a2a-task.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./seam.js";
import { NINE, at, SUBMITTED, newTask, keyOf, messageKeyOf, saved } from "./a2a-task-data.js";

type Instances = ContractInstances<A2ATaskRepository>;

export const A2A_TASK_ACCEPT_CASES: readonly ContractCase<A2ATaskRepository>[] = [
  {
    name: "a task is saved with its first message: version 1, its status time its acceptance",
    run: async ({ first, second }: Instances): Promise<void> => {
      const save = await first.saveIfAbsent(newTask("t-1", { callerPeer: "orders-application" }));

      const expected: A2ATaskRecord = {
        tenantId: "default",
        taskId: "t-1",
        ownerId: "alice",
        contextId: "ctx-1",
        skill: "order-workflow-start",
        status: SUBMITTED,
        version: 1,
        acceptedAt: NINE,
        statusAt: NINE,
        callerPeer: "orders-application",
      };
      expect(save).toEqual({ status: A2ATaskSaveStatus.Saved, task: expected });
      expect(await second.findById(keyOf(expected))).toEqual(expected);
      expect(await second.findByMessage(messageKeyOf(newTask("t-1")))).toEqual({
        tenantId: "default",
        ownerId: "alice",
        messageId: "m-t-1",
        requestHash: "h-1",
        taskId: "t-1",
        savedAt: NINE,
      });
    },
  },
  {
    name: "one message is accepted once, on two instances: the loser gets the winner's task",
    run: async ({ first, second }: Instances): Promise<void> => {
      const message = { messageId: "m-same" };
      const saves = await Promise.all([
        first.saveIfAbsent(newTask("t-1", message)),
        second.saveIfAbsent(newTask("t-2", message)),
      ]);

      const won = saves.filter((save) => save.status === A2ATaskSaveStatus.Saved);
      const lost = saves.filter((save) => save.status === A2ATaskSaveStatus.MessageTaken);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const [winner] = won;
      const [loser] = lost;
      expect(loser?.task).toEqual(winner?.task);
      expect(loser?.message.taskId).toBe(winner?.task.taskId);
      const loserId = winner?.task.taskId === "t-1" ? "t-2" : "t-1";
      expect(await first.findById({ tenantId: "default", taskId: loserId })).toBeUndefined();
    },
  },
  {
    name: "a resent message finds its task and the hash it was accepted with, whatever it sends now",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));

      const again = await second.saveIfAbsent(
        newTask("t-9", { messageId: "m-t-1", requestHash: "h-other" }),
      );

      expect(again).toMatchObject({
        status: A2ATaskSaveStatus.MessageTaken,
        message: { taskId: "t-1", requestHash: "h-1" },
        task: { taskId: "t-1", version: 1 },
      });
      expect(await first.findById({ tenantId: "default", taskId: "t-9" })).toBeUndefined();
    },
  },
  {
    name: "a task id another message's task has saves nothing, not even the message",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));

      const taken = await second.saveIfAbsent(newTask("t-1", { messageId: "m-other" }));

      expect(taken).toEqual({ status: A2ATaskSaveStatus.TaskIdTaken });
      expect(
        await first.findByMessage({ tenantId: "default", ownerId: "alice", messageId: "m-other" }),
      ).toBeUndefined();
    },
  },
  {
    name: "a message id is its tenant's and its owner's: no owner is an owner of its own",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1", { messageId: "m-1" }));

      const others = [
        newTask("t-2", { messageId: "m-1", ownerId: "bob" }),
        newTask("t-3", { messageId: "m-1", ownerId: undefined }),
        newTask("t-4", { messageId: "m-1", tenantId: "acme" }),
      ];
      for (const task of others) await saved(second, task);

      expect(
        await first.findByMessage({ tenantId: "default", ownerId: undefined, messageId: "m-1" }),
      ).toMatchObject({ taskId: "t-3", ownerId: undefined });
      expect(await first.findById({ tenantId: "default", taskId: "t-4" })).toBeUndefined();
      expect(await first.findById({ tenantId: "acme", taskId: "t-4" })).toMatchObject({
        ownerId: "alice",
      });
    },
  },
  {
    name: "a follow-up message is accepted once; its reply is kept once",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));
      const followUp: A2AMessageRecord = {
        tenantId: "default",
        ownerId: "alice",
        messageId: "m-2",
        requestHash: "h-2",
        taskId: "t-1",
        savedAt: at(1),
      };

      const accepted = await Promise.all([
        first.saveMessageIfAbsent(followUp),
        second.saveMessageIfAbsent({ ...followUp, requestHash: "h-3" }),
      ]);
      const replies = await Promise.all([
        first.saveReplyIfAbsent(followUp, { state: "TASK_STATE_WORKING" }),
        second.saveReplyIfAbsent(followUp, { error: -32004 }),
      ]);

      expect(accepted.filter((kept) => kept === undefined)).toHaveLength(1);
      const kept = accepted.find((one) => one !== undefined);
      const stored = await first.findByMessage(followUp);
      expect(kept).toEqual(stored === undefined ? undefined : { ...stored, reply: undefined });
      expect(replies.filter(Boolean)).toHaveLength(1);
      const reply = replies[0] ? { state: "TASK_STATE_WORKING" } : { error: -32004 };
      expect(stored?.reply).toEqual(reply);
      expect(await first.saveReplyIfAbsent({ ...followUp, messageId: "m-none" }, 1)).toBe(false);
      // a message saved with its reply keeps it
      const answered = { ...followUp, messageId: "m-3", reply: { error: { code: -32602 } } };
      await second.saveMessageIfAbsent(answered);
      expect((await first.findByMessage(answered))?.reply).toEqual({ error: { code: -32602 } });
    },
  },
];
