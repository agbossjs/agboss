import { expect } from "vitest";
import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
} from "../../infrastructure/a2a-direct-message.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { nulCaseName } from "./nul-text.js";
import {
  REPLY,
  at,
  keyOf,
  newMessage,
  savedMessage,
  type A2ADirectMessageStores,
} from "./a2a-direct-message-data.js";

type Instances = ContractInstances<A2ADirectMessageStores>;

const KEY = keyOf(newMessage("m-1"));
const NEXT = { attemptId: "run-2", startedAt: at(31), expiresAt: at(61) };

export const A2A_DIRECT_MESSAGE_ATTEMPT_CASES: readonly ContractCase<A2ADirectMessageStores>[] = [
  {
    name: nulCaseName("a completed reply"),
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));

      const written = await second.messages.completeIfInFlight(KEY, "run-m-1", REPLY, at(5));

      expect(written).toMatchObject({ state: A2ADirectMessageState.Completed, reply: REPLY });
      expect(written?.completedAt).toEqual(at(5));
      expect(await first.messages.findByKey(KEY)).toEqual(written);
    },
  },
  {
    name: "a reply is kept only by the attempt in flight, once: a completed one never changes",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));

      const stale = await second.messages.completeIfInFlight(KEY, "run-other", REPLY, at(5));
      const kept = await first.messages.completeIfInFlight(KEY, "run-m-1", REPLY, at(6));
      const again = await second.messages.completeIfInFlight(KEY, "run-m-1", REPLY, at(7));

      expect(stale).toBeUndefined();
      expect(kept?.completedAt).toEqual(at(6));
      expect(again).toBeUndefined();
      expect(await second.messages.deleteIfInFlight(KEY, "run-m-1")).toBe(false);
      expect(await second.messages.retakeIfExpired(KEY, "run-m-1", NEXT, at(99))).toBeUndefined();
      expect((await first.messages.findByKey(KEY))?.completedAt).toEqual(at(6));
    },
  },
  {
    name: "an attempt is taken over only once it expired, by exactly one of two instances",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));

      const early = await second.messages.retakeIfExpired(KEY, "run-m-1", NEXT, at(29));
      const wrong = await second.messages.retakeIfExpired(KEY, "run-other", NEXT, at(30));
      const takes = await Promise.all([
        first.messages.retakeIfExpired(KEY, "run-m-1", NEXT, at(30)),
        second.messages.retakeIfExpired(KEY, "run-m-1", { ...NEXT, attemptId: "run-3" }, at(30)),
      ]);

      expect(early).toBeUndefined();
      expect(wrong).toBeUndefined();
      const won = takes.filter((take) => take !== undefined);
      expect(won).toHaveLength(1);
      const kept = await first.messages.findByKey(KEY);
      expect(kept).toEqual(won[0]);
      expect(kept?.state).toBe(A2ADirectMessageState.InFlight);
      expect(kept?.createdAt).toEqual(newMessage("m-1").createdAt);
      // the old attempt's reply is refused: only the new one completes it
      expect(
        await first.messages.completeIfInFlight(KEY, "run-m-1", REPLY, at(40)),
      ).toBeUndefined();
    },
  },
  {
    name: "a failed attempt is removed only while in flight under it; the message may then run again",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMessage(first.messages, newMessage("m-1"));

      expect(await second.messages.deleteIfInFlight(KEY, "run-other")).toBe(false);
      expect(await second.messages.deleteIfInFlight(KEY, "run-m-1")).toBe(true);
      expect(await first.messages.deleteIfInFlight(KEY, "run-m-1")).toBe(false);

      expect(await first.messages.findByKey(KEY)).toBeUndefined();
      // its id stays claimed: the same message saves again, another one is refused
      const other = await second.messages.saveIfAbsent(newMessage("m-1", { requestHash: "h-2" }));
      expect(other).toEqual({ status: A2ADirectMessageSaveStatus.Taken });
      const same = await second.messages.saveIfAbsent(newMessage("m-1", { attemptId: "run-2" }));
      expect(same.status).toBe(A2ADirectMessageSaveStatus.Saved);
    },
  },
  {
    name: "a message not kept has no attempt: none completed, taken over or removed; the store answers its ping",
    run: async ({ first }: Instances): Promise<void> => {
      await expect(first.messages.ping()).resolves.toBeUndefined();
      expect(await first.messages.completeIfInFlight(KEY, "run-m-1", REPLY, at(5))).toBeUndefined();
      expect(await first.messages.retakeIfExpired(KEY, "run-m-1", NEXT, at(99))).toBeUndefined();
      expect(await first.messages.deleteIfInFlight(KEY, "run-m-1")).toBe(false);
    },
  },
];
