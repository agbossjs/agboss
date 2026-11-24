/**
 * #1366: the record a pause step makes carries only the fields that have a value (no `boundAt`
 * without a run or quorum bound, no `remindAt` without a reminder, no `toolLoopIteration` outside
 * a tool loop), lists the branch keys of the waiting step and of every step that launched its
 * executions, and a working-time reminder asks the calendar nothing without a deadline and is set
 * only strictly after the ask.
 */
import { describe, expect, it } from "vitest";
import type { FrameSpec } from "../../../src/flow/context/frame.js";
import {
  boundedDeadlineOf,
  branchKeyOf,
  newRecordOf,
  reminderOf,
} from "../../../src/flow/runtime/pause-record-made.js";
import type { PauseChannel, PauseQuestion } from "../../../src/flow/runtime/pause.js";
import { PauseKind } from "../../../src/infrastructure/pause-record.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { hours, minutes, workingHours, type WorkingDuration } from "../../../src/units/index.js";

const ASKED = new Date("2026-01-01T00:00:00.000Z");

interface StepFacts {
  idempotencyKey: string;
  nodeId: string;
  visitNumber: number;
  copyNumber: number;
  validationAttempts: number;
  component: { name: string; kind: string; promptHash: string; schemaHash: string };
  toolLoopIteration?: number;
}

const stepOf = (nodeId: string, extra: Partial<StepFacts> = {}): StepFacts => ({
  idempotencyKey: `key-${nodeId}`,
  nodeId,
  visitNumber: 1,
  copyNumber: 0,
  validationAttempts: 0,
  component: { name: nodeId, kind: "step", promptHash: "p", schemaHash: "s" },
  ...extra,
});

const frameOf = (step: StepFacts, parent?: FrameSpec): FrameSpec =>
  ({
    step,
    execution: {
      executionId: parent === undefined ? "root" : "child",
      threadId: "t",
      tenant: { tenantId: "acme" },
      workflow: { name: "wf" },
      itemIndex: undefined,
      ...(parent === undefined
        ? {}
        : { parent: { execution: parent.execution, step: parent.step } }),
    },
  }) as never;

const channel: PauseChannel = {
  name: "ops",
  sender: {} as never,
  answerer: {} as never,
};

const question: PauseQuestion = {
  kind: PauseKind.Question,
  step: "ask",
  input: {},
};

const noCalendar = (): Promise<Date> => Promise.reject(new Error("no calendar"));

describe("#1366: the record a pause step makes", () => {
  it("has no boundAt, remindAt or toolLoopIteration when none applies", async () => {
    const record = await newRecordOf(
      frameOf(stepOf("ask")),
      channel,
      question,
      new VirtualClock(ASKED),
      noCalendar,
    );

    expect("boundAt" in record).toBe(false);
    expect("remindAt" in record).toBe(false);
    expect("toolLoopIteration" in record).toBe(false);
    expect("expiresAt" in record).toBe(false);
  });

  it("carries the toolLoopIteration of a step inside a tool loop", async () => {
    const record = await newRecordOf(
      frameOf(stepOf("ask", { toolLoopIteration: 3 })),
      channel,
      question,
      new VirtualClock(ASKED),
      noCalendar,
    );

    expect(record.toolLoopIteration).toBe(3);
  });

  it("carries the reminder when the deadline is far enough, as an ISO instant", async () => {
    const record = await newRecordOf(
      frameOf(stepOf("ask")),
      { ...channel, expiresIn: hours(2), remindBefore: hours(1) },
      question,
      new VirtualClock(ASKED),
      noCalendar,
    );

    expect(record.remindAt).toBe(new Date(ASKED.getTime() + hours(1)).toISOString());
    expect(record.expiresAt).toBe(new Date(ASKED.getTime() + hours(2)).toISOString());
  });

  it("lists only its own branch key for a step of a root execution", async () => {
    const record = await newRecordOf(
      frameOf(stepOf("ask")),
      channel,
      question,
      new VirtualClock(ASKED),
      noCalendar,
    );

    expect(record.branchKeys).toEqual(["root:ask:1"]);
  });

  it("lists the launching step's key before its own for a child execution", async () => {
    const launcher = frameOf(stepOf("launch"));
    const record = await newRecordOf(
      frameOf(stepOf("ask"), launcher),
      channel,
      question,
      new VirtualClock(ASKED),
      noCalendar,
    );

    expect(record.branchKeys).toEqual(["root:launch:1", "child:ask:1"]);
  });

  it("branchKeyOf names execution, node, visit and item index", () => {
    expect(branchKeyOf({ executionId: "e", nodeId: "n", visitNumber: 2, itemIndex: 4 })).toBe(
      "e:n:2:4",
    );
    expect(branchKeyOf({ executionId: "e", nodeId: "n", visitNumber: 2 })).toBe("e:n:2");
  });
});

describe("#1366: the deadline fields hold only what is set", () => {
  it("a pause with only its own deadline has no boundAt key", () => {
    const own = new Date(ASKED.getTime() + minutes(10)).toISOString();

    const fields = boundedDeadlineOf({ execution: {} } as never, own);

    expect(Object.keys(fields).sort()).toEqual(["expiresAt", "expiryBound"]);
  });
});

describe("#1366: a working-time reminder asks the calendar only for a deadline", () => {
  it("asks nothing and is none when there is no deadline, whatever the lead", async () => {
    const asked: number[] = [];
    const counting = (from: Date, amount: WorkingDuration): Promise<Date> => {
      asked.push(amount.amount);
      return Promise.resolve(new Date(from.getTime() + amount.amount));
    };

    const none = await reminderOf(
      ASKED,
      { expiresAt: undefined, expiresIn: workingHours(8) },
      workingHours(1),
      counting,
    );

    expect(none).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("is none when the calendar's instant is not after the ask (or is the ask itself)", async () => {
    const expiresAt = new Date(ASKED.getTime() + hours(8)).toISOString();
    const deadline = { expiresAt, expiresIn: workingHours(8) };

    const same = await reminderOf(ASKED, deadline, workingHours(1), () => Promise.resolve(ASKED));
    const before = await reminderOf(ASKED, deadline, workingHours(1), () =>
      Promise.resolve(new Date(ASKED.getTime() - 1)),
    );

    expect(same).toBeUndefined();
    expect(before).toBeUndefined();
  });
});
