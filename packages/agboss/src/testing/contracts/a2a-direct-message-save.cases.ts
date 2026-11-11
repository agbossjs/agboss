import { expect } from "vitest";
import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type A2ADirectMessageRecord,
} from "../../infrastructure/a2a-direct-message.repository.js";
import { A2ATaskSaveStatus } from "../../infrastructure/a2a-task.repository.js";
import { newTask } from "./a2a-task-data.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  NINE,
  at,
  keyOf,
  newMessage,
  savedMessage,
  type A2ADirectMessageStores,
} from "./a2a-direct-message-data.js";

type Instances = ContractInstances<A2ADirectMessageStores>;

const EXPECTED: A2ADirectMessageRecord = {
  tenantId: "default",
  ownerId: "alice",
  messageId: "m-1",
  requestHash: "h-1",
  skill: "quote-workflow-start",
  contextId: "ctx-1",
  state: A2ADirectMessageState.InFlight,
  attemptId: "run-m-1",
  startedAt: NINE,
  expiresAt: at(30),
  callsModel: true,
  createdAt: NINE,
  callerPeer: "orders-application",
  meshBodyHash: `sha256:${"ab".repeat(32)}`,
};

export const A2A_DIRECT_MESSAGE_SAVE_CASES: readonly ContractCase<A2ADirectMessageStores>[] = [
  {
    name: "a message is saved in flight and read back on another instance, field by field",
    run: async ({ first, second }: Instances): Promise<void> => {
      const save = await first.messages.saveIfAbsent(
        newMessage("m-1", { callerPeer: EXPECTED.callerPeer, meshBodyHash: EXPECTED.meshBodyHash }),
      );

      expect(save).toEqual({ status: A2ADirectMessageSaveStatus.Saved, message: EXPECTED });
      expect(await second.messages.findByKey(keyOf(EXPECTED))).toEqual(EXPECTED);
      const plain = await savedMessage(first.messages, newMessage("m-2", { callsModel: false }));
      expect(plain).not.toHaveProperty("callerPeer");
      expect(plain).not.toHaveProperty("meshBodyHash");
      expect((await second.messages.findByKey(keyOf(plain)))?.callsModel).toBe(false);
    },
  },
  {
    name: "one message is accepted once, on two instances: the loser gets the winner's row",
    run: async ({ first, second }: Instances): Promise<void> => {
      const saves = await Promise.all([
        first.messages.saveIfAbsent(newMessage("m-1", { attemptId: "run-a" })),
        second.messages.saveIfAbsent(newMessage("m-1", { attemptId: "run-b" })),
      ]);

      const statuses = saves.map((save) => save.status).sort();
      expect(statuses).toEqual([A2ADirectMessageSaveStatus.Kept, A2ADirectMessageSaveStatus.Saved]);
      const [one, two] = saves.map((save) => ("message" in save ? save.message : undefined));
      expect(one).toBeDefined();
      expect(one).toEqual(two);
    },
  },
  {
    name: "a resend finds the row and the hash it was accepted with, whatever it sends now",
    run: async ({ first, second }: Instances): Promise<void> => {
      const saved = await savedMessage(first.messages, newMessage("m-1"));

      const again = await second.messages.saveIfAbsent(newMessage("m-1", { requestHash: "h-2" }));

      expect(again).toEqual({ status: A2ADirectMessageSaveStatus.Kept, message: saved });
    },
  },
  {
    name: "another owner's or tenant's message of one id is another message; no owner is none of them",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));

      for (const other of [{ ownerId: "bob" }, { ownerId: undefined }, { tenantId: "acme" }]) {
        const save = await second.messages.saveIfAbsent(newMessage("m-1", other));
        expect(save.status).toBe(A2ADirectMessageSaveStatus.Saved);
      }
      const none = await first.messages.findByKey({
        tenantId: "default",
        ownerId: undefined,
        messageId: "m-1",
      });
      expect(none?.ownerId).toBeUndefined();
    },
  },
];

/** One id, two reply modes: the claim among the task store's messages (#860 AC3 of #805). */
export const A2A_DIRECT_MESSAGE_CLAIM_CASES: readonly ContractCase<A2ADirectMessageStores>[] = [
  {
    name: "an id a task message has is taken for a direct message: nothing saved",
    run: async ({ first, second }: Instances): Promise<void> => {
      await first.tasks.saveIfAbsent(newTask("t-1", { messageId: "m-1" }));

      const save = await second.messages.saveIfAbsent(newMessage("m-1"));

      expect(save).toEqual({ status: A2ADirectMessageSaveStatus.Taken });
      expect(await first.messages.findByKey(keyOf(newMessage("m-1")))).toBeUndefined();
    },
  },
  {
    name: "a direct message's id is claimed of no task: a task or a follow-up under it finds the claim",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));

      const task = await second.tasks.saveIfAbsent(newTask("t-1", { messageId: "m-1" }));
      const followUp = await second.tasks.saveMessageIfAbsent({
        tenantId: "default",
        ownerId: "alice",
        messageId: "m-1",
        requestHash: "h-9",
        taskId: "t-1",
        savedAt: NINE,
      });

      expect(task.status).toBe(A2ATaskSaveStatus.MessageTaken);
      if (task.status !== A2ATaskSaveStatus.MessageTaken) return;
      expect(task.message).toMatchObject({ taskId: "", requestHash: "h-1" });
      expect(task.task).toBeUndefined();
      expect(followUp).toMatchObject({ taskId: "", requestHash: "h-1" });
      expect(await first.tasks.findById({ tenantId: "default", taskId: "t-1" })).toBeUndefined();
    },
  },
  {
    name: "a task message and a direct message of one id, on two instances at once: exactly one is kept",
    run: async ({ first, second }: Instances): Promise<void> => {
      const [task, direct] = await Promise.all([
        first.tasks.saveIfAbsent(newTask("t-1", { messageId: "m-1" })),
        second.messages.saveIfAbsent(newMessage("m-1")),
      ]);

      const taskWon = task.status === A2ATaskSaveStatus.Saved;
      const directWon = direct.status === A2ADirectMessageSaveStatus.Saved;
      expect([taskWon, directWon].filter(Boolean)).toHaveLength(1);
      expect(direct.status).toBe(
        taskWon ? A2ADirectMessageSaveStatus.Taken : A2ADirectMessageSaveStatus.Saved,
      );
    },
  },
];
