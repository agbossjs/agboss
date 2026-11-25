import { expect } from "vitest";
import { A2ADirectMessageSaveStatus } from "../../infrastructure/a2a-direct-message.repository.js";
import { A2ATaskSaveStatus } from "../../infrastructure/a2a-task.repository.js";
import { newTask } from "./a2a-task-data.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  NINE,
  REPLY,
  at,
  cutoffsOf,
  keyOf,
  newMessage,
  savedMessage,
  type A2ADirectMessageStores,
} from "./a2a-direct-message-data.js";

type Instances = ContractInstances<A2ADirectMessageStores>;

/** Three messages accepted at nine + 0, 10 and 20 s, each in flight for 30 s; m-1 completed. */
async function three({ messages }: A2ADirectMessageStores): Promise<void> {
  for (const n of [1, 2, 3]) {
    const created = at((n - 1) * 10);
    const message = newMessage(`m-${String(n)}`, {
      createdAt: created,
      startedAt: created,
      expiresAt: at((n - 1) * 10 + 30),
    });
    await savedMessage(messages, message);
  }
  await messages.completeIfInFlight(keyOf(newMessage("m-1")), "run-m-1", REPLY, at(5));
}

const ids = (found: readonly { readonly messageId: string }[]): string[] =>
  found.map((message) => message.messageId);

export const A2A_DIRECT_MESSAGE_SWEEP_CASES: readonly ContractCase<A2ADirectMessageStores>[] = [
  {
    name: "the expired attempts in flight are found oldest first, at most the limit; a completed one never",
    run: async ({ first, second }: Instances): Promise<void> => {
      await three(first);

      expect(ids(await second.messages.findAllInFlightByExpiresAtBefore(at(39), 10))).toEqual([]);
      expect(ids(await second.messages.findAllInFlightByExpiresAtBefore(at(40), 10))).toEqual([
        "m-2",
      ]);
      expect(ids(await second.messages.findAllInFlightByExpiresAtBefore(at(99), 10))).toEqual([
        "m-2",
        "m-3",
      ]);
      expect(ids(await second.messages.findAllInFlightByExpiresAtBefore(at(99), 1))).toEqual([
        "m-2",
      ]);
      await expect(second.messages.findAllInFlightByExpiresAtBefore(at(99), 0)).rejects.toThrow(
        RangeError,
      );
    },
  },
  {
    name: "the sweep removes completed messages whose reply was kept before its cutoff, oldest first and at most the limit, with their ids' claims",
    run: async ({ first, second }: Instances): Promise<void> => {
      await three(first);
      await first.messages.completeIfInFlight(keyOf(newMessage("m-2")), "run-m-2", REPLY, at(12));

      const page = await second.messages.deleteExpired(cutoffsOf(at(15)), 1);
      expect(await first.messages.findByKey(keyOf(newMessage("m-1")))).toBeUndefined();
      expect(await first.messages.findByKey(keyOf(newMessage("m-2")))).toBeDefined();
      const rest = await second.messages.deleteExpired(cutoffsOf(at(15)), 10);
      // a message completed at the cutoff itself is kept; one in flight never goes
      const none = await second.messages.deleteExpired(cutoffsOf(at(20)), 10);

      expect([page, rest, none]).toEqual([1, 1, 0]);
      expect(await first.messages.findByKey(keyOf(newMessage("m-2")))).toBeUndefined();
      expect(await first.messages.findByKey(keyOf(newMessage("m-3")))).toBeDefined();
      // past its retention an id is free: a task message takes it; m-3's is still claimed
      const task = await first.tasks.saveIfAbsent(newTask("t-1", { messageId: "m-1" }));
      expect(task.status).toBe(A2ATaskSaveStatus.Saved);
      const held = await first.tasks.saveIfAbsent(newTask("t-3", { messageId: "m-3" }));
      expect(held.status).toBe(A2ATaskSaveStatus.MessageTaken);
      await expect(second.messages.deleteExpired(cutoffsOf(at(99)), 0)).rejects.toThrow(RangeError);
    },
  },
  {
    name: "the sweep frees the id of a failed message too, and never a task's",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));
      await first.messages.deleteIfInFlight(keyOf(newMessage("m-1")), "run-m-1");
      await first.tasks.saveIfAbsent(newTask("t-2", { messageId: "m-2" }));

      await second.messages.deleteExpired(cutoffsOf(at(60)), 10);

      const other = await first.messages.saveIfAbsent(newMessage("m-1", { requestHash: "h-2" }));
      expect(other.status).toBe(A2ADirectMessageSaveStatus.Saved);
      expect(await first.tasks.findByMessage(keyOf(newMessage("m-2")))).toBeDefined();
    },
  },
  {
    name: "a resend of a failed message and the sweep at once: a message kept keeps its id's claim",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));
      await first.messages.deleteIfInFlight(keyOf(newMessage("m-1")), "run-m-1");
      const resent = newMessage("m-1", {
        attemptId: "run-2",
        createdAt: at(90),
        startedAt: at(90),
      });

      const [save] = await Promise.all([
        first.messages.saveIfAbsent({ ...resent, expiresAt: at(120) }),
        second.messages.deleteExpired(cutoffsOf(at(60)), 10),
      ]);

      const kept = await first.messages.findByKey(keyOf(resent));
      const task = await second.tasks.saveIfAbsent(newTask("t-1", { messageId: "m-1" }));
      if (save.status === A2ADirectMessageSaveStatus.Saved && kept !== undefined)
        expect(task.status).toBe(A2ATaskSaveStatus.MessageTaken);
      expect(kept === undefined).toBe(task.status === A2ATaskSaveStatus.Saved);
    },
  },
  {
    name: "the sweep's pages are oldest first by when the reply was kept, whatever order the messages were accepted in",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(
        first.messages,
        newMessage("m-late", { createdAt: at(10), expiresAt: at(50) }),
      );
      await savedMessage(first.messages, newMessage("m-early", { expiresAt: at(40) }));
      const lost = await second.messages.findAllInFlightByExpiresAtBefore(at(99), 10);
      // completed in the opposite order: the sweep goes by when the reply was kept
      await first.messages.completeIfInFlight(
        keyOf(newMessage("m-late")),
        "run-m-late",
        REPLY,
        at(54),
      );
      await first.messages.completeIfInFlight(
        keyOf(newMessage("m-early")),
        "run-m-early",
        REPLY,
        at(55),
      );

      const gone = await second.messages.deleteExpired(cutoffsOf(at(60)), 1);

      expect([ids(lost), gone]).toEqual([["m-early", "m-late"], 1]);
      expect(await first.messages.findByKey(keyOf(newMessage("m-late")))).toBeUndefined();
      expect(await first.messages.findByKey(keyOf(newMessage("m-early")))).toBeDefined();
    },
  },
  {
    name: "the sweep frees the claims of the messages it removes, and at most its limit more of failed ones",
    run: async ({ first, second }: Instances): Promise<void> => {
      for (const failed of ["f-1", "f-2"]) {
        await savedMessage(first.messages, newMessage(failed));
        await first.messages.deleteIfInFlight(keyOf(newMessage(failed)), `run-${failed}`);
      }
      await savedMessage(first.messages, newMessage("m-3", { createdAt: at(5) }));
      await first.messages.completeIfInFlight(keyOf(newMessage("m-3")), "run-m-3", REPLY, at(9));

      await second.messages.deleteExpired(cutoffsOf(at(60)), 1);

      const taskOf = (messageId: string) =>
        first.tasks.saveIfAbsent(newTask(`t-${messageId}`, { messageId }));
      expect((await taskOf("m-3")).status).toBe(A2ATaskSaveStatus.Saved);
      const failed = [await taskOf("f-1"), await taskOf("f-2")];
      expect(failed.filter((task) => task.status === A2ATaskSaveStatus.Saved).length).toBeLessThan(
        2,
      );
    },
  },
  {
    name: "a failed message keeps its id's claim from its first acceptance: at the cutoff it stays, resent later it goes",
    run: async ({ first, second }: Instances): Promise<void> => {
      const failedAt = async (messageId: string, createdAt: Date) => {
        const message = newMessage(messageId, {
          createdAt,
          attemptId: `run-${String(createdAt.getTime())}`,
        });
        await savedMessage(first.messages, message);
        await first.messages.deleteIfInFlight(keyOf(message), message.attemptId);
      };
      await failedAt("m-1", at(60));
      await failedAt("m-2", NINE);
      await failedAt("m-2", at(90));

      await second.messages.deleteExpired(cutoffsOf(at(60)), 10);

      const taskOf = (messageId: string) =>
        first.tasks.saveIfAbsent(newTask(`t-${messageId}`, { messageId }));
      expect([(await taskOf("m-1")).status, (await taskOf("m-2")).status]).toEqual([
        A2ATaskSaveStatus.MessageTaken,
        A2ATaskSaveStatus.Saved,
      ]);
    },
  },
  {
    name: "each endpoint's replies are swept at its own cutoff: another endpoint's, or one of none listed, stays",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));
      await savedMessage(first.messages, newMessage("m-2", { endpoint: "support" }));
      for (const id of ["m-1", "m-2"])
        await first.messages.completeIfInFlight(keyOf(newMessage(id)), `run-${id}`, REPLY, at(5));

      expect(await second.messages.deleteExpired(new Map(), 10)).toBe(0);
      expect(await second.messages.deleteExpired(cutoffsOf(at(10)), 10)).toBe(1);

      expect(await first.messages.findByKey(keyOf(newMessage("m-1")))).toBeUndefined();
      expect(await first.messages.findByKey(keyOf(newMessage("m-2")))).toBeDefined();
      // m-2's claim is its endpoint's too: a task takes m-1's id, never m-2's
      const free = await first.tasks.saveIfAbsent(newTask("t-1", { messageId: "m-1" }));
      const held = await first.tasks.saveIfAbsent(newTask("t-2", { messageId: "m-2" }));
      expect([free.status, held.status]).toEqual([
        A2ATaskSaveStatus.Saved,
        A2ATaskSaveStatus.MessageTaken,
      ]);
    },
  },
];
