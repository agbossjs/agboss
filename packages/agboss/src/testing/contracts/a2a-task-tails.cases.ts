import { expect } from "vitest";
import type {
  A2AMessageRecord,
  A2ATaskRepository,
} from "../../infrastructure/a2a-task.repository.js";
import { A2ATaskSaveStatus, A2ATaskState } from "../../infrastructure/a2a-task.repository.js";
import { PauseKind } from "../../pause/types.js";
import { DIRECT_MESSAGE_CLAIM } from "../../infrastructure/in-memory-a2a-direct-message.repository.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import {
  at,
  COMPLETED,
  keyOf,
  messageKeyOf,
  newTask,
  saved,
  savedMany,
  WORKING,
} from "./a2a-task-data.js";

type Instances = ContractInstances<A2ATaskRepository>;

/** A follow-up message of alice, accepted for `taskId` of `tenantId` at `savedAt`. */
const followUp = (
  messageId: string,
  taskId: string,
  savedAt: Date,
  tenantId = "default",
): A2AMessageRecord => ({
  tenantId,
  ownerId: "alice",
  messageId,
  requestHash: "h-9",
  taskId,
  savedAt,
});

/** The rule for a status written beside the keys this version knows (#960 AC3). */
export const A2A_TASK_STATUS_KEY_CASES: readonly ContractCase<A2ATaskRepository>[] = [
  {
    name: "a status key this version does not know survives every round trip: saved, written, read, listed",
    run: async ({ first, second }: Instances): Promise<void> => {
      const future = { ...WORKING, futureField: { count: 1, tags: ["a"] } };
      const later = { ...COMPLETED, futureField: { count: 2, tags: [] } };
      const key = keyOf(newTask("t-1"));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 10 };

      await saved(first, newTask("t-1", { status: future }));
      expect((await second.findById(key))?.status).toEqual(future);

      const written = await second.compareAndSetStatus(key, 1, later, at(1));

      expect(written?.status).toEqual(later);
      expect((await first.findById(key))?.status).toEqual(later);
      expect((await first.list(query)).tasks[0]?.status).toEqual(later);
    },
  },
  {
    name: "a key this version does not know inside a pending pause survives every round trip too: one rule at every level",
    run: async ({ first, second }: Instances): Promise<void> => {
      const pause = { pauseId: "p-1", kind: PauseKind.Approval, ask: { q: 1 } };
      const future = {
        state: A2ATaskState.InputRequired,
        pendingPauses: [{ ...pause, futureKey: { count: 1 } }],
        futureTop: 1,
      };
      const later = {
        state: A2ATaskState.InputRequired,
        pendingPauses: [
          { ...pause, futureKey: { count: 2 } },
          { ...pause, pauseId: "p-2" },
        ],
      };
      const key = keyOf(newTask("t-1"));
      const query = { tenantId: "default", ownerId: "alice", pageSize: 10 };

      await saved(first, newTask("t-1", { status: future }));
      expect((await second.findById(key))?.status).toEqual(future);

      const written = await second.compareAndSetStatus(key, 1, later, at(1));

      expect(written?.status).toEqual(later);
      expect((await first.findById(key))?.status).toEqual(later);
      expect((await first.list(query)).tasks[0]?.status).toEqual(later);
    },
  },
];

/** What the sweep does with a message whose task is gone (#960 AC1). */
export const A2A_TASK_ORPHAN_CASES: readonly ContractCase<A2ATaskRepository>[] = [
  {
    name: "the sweep removes a message whose task is gone once its savedAt is before the cutoff; never one of a kept task",
    run: async ({ first, second }: Instances): Promise<void> => {
      await savedMany(first, 1);
      // a follow-up saved while the sweep removed its task (or of another tenant: t-1 is no task of acme)
      const orphan = followUp("m-orphan", "t-gone", at(5));
      const strayed = followUp("m-acme", "t-1", at(5), "acme");
      const live = followUp("m-live", "t-1", at(5));
      for (const message of [orphan, strayed, live])
        expect(await first.saveMessageIfAbsent(message)).toBeUndefined();
      await first.saveReplyIfAbsent(orphan, { accepted: true });

      await second.deleteTerminalByStatusAtBefore(at(5));
      // a message saved at the cutoff itself is kept, as a task that ended there is
      expect(await first.findByMessage(orphan)).toBeDefined();

      await second.deleteTerminalByStatusAtBefore(at(6));

      expect(await first.findByMessage(orphan)).toBeUndefined();
      expect(await first.findByMessage(strayed)).toBeUndefined();
      expect(await first.findByMessage(live)).toBeDefined();
      expect(await first.findById(keyOf(newTask("t-1")))).toBeDefined();
    },
  },
  {
    name: "a finished task's messages go with it, however late a follow-up was saved",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));
      await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, COMPLETED, at(5));
      // saved after the cutoff, to a task that is over: it goes with its task, not by its age
      const late = followUp("m-late", "t-1", at(25));
      expect(await first.saveMessageIfAbsent(late)).toBeUndefined();

      await second.deleteTerminalByStatusAtBefore(at(20));

      expect(await first.findById(keyOf(newTask("t-1")))).toBeUndefined();
      expect(await first.findByMessage(late)).toBeUndefined();
      expect(await first.findByMessage(messageKeyOf(newTask("t-1")))).toBeUndefined();
    },
  },
  {
    name: "a direct message's claim has no task by design: the orphan sweep never removes it, and a resend is still a duplicate",
    run: async ({ first, second }: Instances): Promise<void> => {
      const claim = followUp("m-direct", DIRECT_MESSAGE_CLAIM, at(1));
      expect(await first.saveMessageIfAbsent(claim)).toBeUndefined();

      await second.deleteTerminalByStatusAtBefore(at(60));

      expect(await first.findByMessage(claim)).toEqual(claim);
      expect(await second.saveMessageIfAbsent(claim)).toEqual(claim);
      expect((await second.saveIfAbsent(newTask("t-9", { messageId: "m-direct" }))).status).toBe(
        A2ATaskSaveStatus.MessageTaken,
      );
    },
  },
  {
    name: "a message id swept as an orphan is free again: a resend is saved anew, never read as accepted before",
    run: async ({ first, second }: Instances): Promise<void> => {
      // t-1 completes and is swept with its messages; a follow-up saved just after is left behind
      await saved(first, newTask("t-1"));
      await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, COMPLETED, at(1));
      await first.deleteTerminalByStatusAtBefore(at(2));
      const orphan = followUp("m-late", "t-1", at(3));
      expect(await first.saveMessageIfAbsent(orphan)).toBeUndefined();
      expect(await second.saveMessageIfAbsent(orphan)).toEqual(orphan);

      await second.deleteTerminalByStatusAtBefore(at(4));

      expect(await first.findByMessage(orphan)).toBeUndefined();
      const resent = await second.saveIfAbsent(newTask("t-2", { messageId: "m-late" }));
      expect(resent.status).toBe(A2ATaskSaveStatus.Saved);
    },
  },
];
