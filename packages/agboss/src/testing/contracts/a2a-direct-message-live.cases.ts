import { expect } from "vitest";
import { A2ADirectMessageState } from "../../infrastructure/a2a-direct-message.repository.js";
import { A2ATaskSaveStatus } from "../../infrastructure/a2a-task.repository.js";
import { newTask } from "./a2a-task-data.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  REPLY,
  at,
  keyOf,
  newMessage,
  savedMessage,
  type A2ADirectMessageStores,
} from "./a2a-direct-message-data.js";

type Instances = ContractInstances<A2ADirectMessageStores>;

/**
 * #860 D2: a live attempt outlives the retention. The sweep removes completed messages only: an
 * attempt in flight — however old its message — keeps its row, its id's claim and its reply to
 * come (a lost one leaves by `deleteIfInFlight`, settled once). A message taken over is accepted
 * anew, its retention counted from the takeover, so a reply a takeover keeps is kept the whole
 * retention after it.
 */
export const A2A_DIRECT_MESSAGE_LIVE_CASES: readonly ContractCase<A2ADirectMessageStores>[] = [
  {
    name: "an attempt in flight is never swept, however old its message: its row, its id's claim and its reply stay",
    run: async ({ first, second }: Instances): Promise<void> => {
      const message = newMessage("m-1");
      await savedMessage(first.messages, message);

      const gone = await second.messages.deleteByCreatedAtBefore(at(3600), 10);

      expect(gone).toEqual([]);
      const task = await second.tasks.saveIfAbsent(newTask("t-1", { messageId: "m-1" }));
      expect(task.status).toBe(A2ATaskSaveStatus.MessageTaken);
      const kept = await first.messages.completeIfInFlight(keyOf(message), "run-m-1", REPLY, at(9));
      expect(kept?.state).toBe(A2ADirectMessageState.Completed);
    },
  },
  {
    name: "a message taken over is accepted anew: its retention counts from the takeover",
    run: async ({ first, second }: Instances): Promise<void> => {
      const message = newMessage("m-1");
      await savedMessage(first.messages, message);
      const next = { attemptId: "run-2", startedAt: at(31), expiresAt: at(61) };

      const taken = await second.messages.retakeIfExpired(keyOf(message), "run-m-1", next, at(31));
      await second.messages.completeIfInFlight(keyOf(message), "run-2", REPLY, at(50));
      const early = await first.messages.deleteByCreatedAtBefore(at(31), 10);
      const later = await first.messages.deleteByCreatedAtBefore(at(32), 10);

      expect(taken?.createdAt).toEqual(at(31));
      expect(early).toEqual([]);
      expect(later.map((gone) => [gone.messageId, gone.attemptId])).toEqual([["m-1", "run-2"]]);
    },
  },
];
