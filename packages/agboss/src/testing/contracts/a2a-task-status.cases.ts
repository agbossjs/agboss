import { expect } from "vitest";
import {
  A2ATaskState,
  type A2ATaskRepository,
  type A2ATaskStatus,
} from "../../infrastructure/a2a-task.repository.js";
import { PauseKind } from "../../pause/types.js";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import { at, SUBMITTED, WORKING, COMPLETED, newTask, keyOf, saved } from "./a2a-task-data.js";

type Instances = ContractInstances<A2ATaskRepository>;

export const A2A_TASK_STATUS_CASES: readonly ContractCase<A2ATaskRepository>[] = [
  {
    name: "a status is written at the expected version only: version + 1, its time",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));

      const written = await second.compareAndSetStatus(keyOf(newTask("t-1")), 1, WORKING, at(1));
      const stale = await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, SUBMITTED, at(2));

      expect(written).toMatchObject({ status: WORKING, version: 2, statusAt: at(1) });
      expect(stale).toBeUndefined();
      expect(await first.findById(keyOf(newTask("t-1")))).toEqual(written);
    },
  },
  {
    name: "two writes at one version, on two instances: exactly one lands",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));
      const key = keyOf(newTask("t-1"));

      const writes = await Promise.all([
        first.compareAndSetStatus(key, 1, WORKING, at(1)),
        second.compareAndSetStatus(key, 1, COMPLETED, at(1)),
      ]);

      const landed = writes.filter((write) => write !== undefined);
      expect(landed).toHaveLength(1);
      expect(await first.findById(key)).toEqual(landed[0]);
    },
  },
  {
    name: "a terminal status is sticky: no write lands on it, at its own version either",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));
      const key = keyOf(newTask("t-1"));
      await first.compareAndSetStatus(key, 1, COMPLETED, at(1));

      const late = await second.compareAndSetStatus(key, 2, WORKING, at(2));
      const again = await second.compareAndSetStatus(key, 2, COMPLETED, at(2));

      expect(late).toBeUndefined();
      expect(again).toBeUndefined();
      expect(await first.findById(key)).toMatchObject({ status: COMPLETED, version: 2 });
    },
  },
  {
    name: "a task saved rejected is terminal from the start",
    run: async ({ first }: Instances): Promise<void> => {
      const rejected: A2ATaskStatus = {
        state: A2ATaskState.Rejected,
        pendingPauses: [],
        errorCode: "limit.hops",
        message: "too many hops",
      };
      await saved(first, newTask("t-1", { status: rejected }));

      expect(
        await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, WORKING, at(1)),
      ).toBeUndefined();
    },
  },
  {
    name: "a status comes back as written: pauses, output, code and message",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));
      const waiting: A2ATaskStatus = {
        state: A2ATaskState.InputRequired,
        pendingPauses: [
          {
            pauseId: "p-1",
            kind: PauseKind.Approval,
            ask: { tool: "charge-tool", args: { a: 1 } },
          },
          { kind: PauseKind.Question, ask: { question: "which card?" } },
        ],
        message: "awaiting approval",
      };

      await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, waiting, at(1));

      expect((await second.findById(keyOf(newTask("t-1"))))?.status).toEqual(waiting);
    },
  },
  {
    name: nulCaseName("a task's output"),
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));
      const done = { ...COMPLETED, output: { text: NUL_TEXT }, message: NUL_TEXT };

      await first.compareAndSetStatus(keyOf(newTask("t-1")), 1, done, at(1));

      expect((await second.findById(keyOf(newTask("t-1"))))?.status).toEqual(done);
    },
  },
  {
    name: "another tenant's task does not exist",
    run: async ({ first, second }: Instances): Promise<void> => {
      await saved(first, newTask("t-1"));

      expect(await second.findById({ tenantId: "acme", taskId: "t-1" })).toBeUndefined();
      expect(
        await second.compareAndSetStatus({ tenantId: "acme", taskId: "t-1" }, 1, WORKING, at(1)),
      ).toBeUndefined();
    },
  },
];
