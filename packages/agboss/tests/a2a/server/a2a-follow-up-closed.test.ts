/**
 * #939 (#910 AC7, over A2A): a follow-up to a closed pause is `-32004` with the fixed code
 * `a2a.pause-closed`, the reason and when it closed in its metadata and a constant text per reason —
 * never an error's own message (#807); the refusal is kept and replayed to a resend; a resend whose
 * reply was lost still gets the task; a kept reply of before (`a2a.already-answered`) still replays.
 */
import { describe, expect, it } from "vitest";
import { followedUpTask } from "../../../src/a2a/server/a2a-follow-up.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import {
  DurableExecutionStatus,
  type DurableExecutionState,
} from "../../../src/app/execution-control.js";
import { PauseClosedError } from "../../../src/app/pause-closed-error.js";
import {
  A2ATaskState,
  type A2AMessageKey,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { PauseClosedReason } from "../../../src/infrastructure/pause-record.js";
import {
  callerOf,
  messageOf,
  NINE,
  savedTask,
  scriptOf,
  unitParts,
  type Script,
} from "./support/unit-parts.js";

const INPUT_REQUIRED = { state: A2ATaskState.InputRequired, pendingPauses: [] };
const CLOSED_AT = "2026-01-05T08:30:00.000Z";

const waiting: DurableExecutionState = {
  status: DurableExecutionStatus.Paused,
  pending: [],
};

const decide = (messageId: string) =>
  messageOf(messageId, [], { taskId: "task-1", data: { decision: { ok: true } } });

const keyOf = (messageId: string): A2AMessageKey => ({
  tenantId: "acme",
  ownerId: "dana",
  messageId,
});

async function setUp(script: Script) {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  await savedTask(tasks, {}, INPUT_REQUIRED);
  return { tasks, parts: unitParts(script, tasks) };
}

/** What a follow-up was refused with: the wire error's name, text and metadata. */
async function refusedWith(run: Promise<unknown>) {
  const error: unknown = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error("the follow-up was not refused");
  const { name, message } = error;
  const metadata: unknown = Reflect.get(error, "metadata");
  return { name, message, metadata };
}

const closed = (reason: PauseClosedReason): PauseClosedError =>
  new PauseClosedError({ pauseId: "p-1", tenantId: "acme", reason, closedAt: CLOSED_AT });

/** A script whose pause `p-1` waits (as the task's records say) and whose resume is refused as closed. */
const refusing = (reason: PauseClosedReason): Script =>
  scriptOf({
    state: { status: DurableExecutionStatus.Paused, pending: [{ pauseId: "p-1" }] } as never,
    runError: closed(reason),
  });

const TEXT: Readonly<Record<PauseClosedReason, string>> = {
  [PauseClosedReason.Answered]: "the pause was already answered",
  [PauseClosedReason.Expired]: "the pause expired",
  [PauseClosedReason.Cancelled]: "the task was cancelled",
  [PauseClosedReason.Withdrawn]: "the pause is no longer needed",
  [PauseClosedReason.TreeEnded]: "the task is over",
  [PauseClosedReason.Reassigned]: "the pause moved to someone else",
};

describe("#939 AC4: a follow-up to a closed pause", () => {
  for (const reason of Object.values(PauseClosedReason))
    it(`${reason}: -32004, metadata { code: a2a.pause-closed, reason, closedAt }, the constant text, kept`, async () => {
      const { parts, tasks } = await setUp(refusing(reason));

      const refused = await refusedWith(followedUpTask(parts, callerOf(), decide("f-1")));

      expect(refused).toMatchObject({
        name: "UnsupportedOperationError",
        message: TEXT[reason],
        metadata: { code: "a2a.pause-closed", reason, closedAt: CLOSED_AT },
      });
      expect(refused.message).not.toContain("pause p-1");
      expect((await tasks.findByMessage(keyOf("f-1")))?.reply).toEqual({
        refused: "unsupported",
        code: "a2a.pause-closed",
        reason,
        closedAt: CLOSED_AT,
      });
    });

  it("a resend of a refused follow-up replays the same refusal, resuming nothing again", async () => {
    const script = refusing(PauseClosedReason.Cancelled);
    const { parts } = await setUp(script);
    const first = await refusedWith(followedUpTask(parts, callerOf(), decide("f-1")));

    const again = await refusedWith(followedUpTask(parts, callerOf(), decide("f-1")));

    expect(again).toEqual(first);
    expect(script.resumes).toHaveLength(1);
  });

  it("a resend whose first outcome was lost, its pause closed since: the task as it is, nothing kept or thrown", async () => {
    const script = refusing(PauseClosedReason.Cancelled);
    const { tasks, parts } = await setUp(script);
    const message = decide("f-1");
    await tasks.saveMessageIfAbsent({
      ...keyOf("f-1"),
      requestHash: requestHashOf("unit-workflow-start", message),
      taskId: "task-1",
      savedAt: NINE,
    });

    const answer = await followedUpTask(parts, callerOf(), message);

    expect(answer.task.taskId).toBe("task-1");
    expect((await tasks.findByMessage(keyOf("f-1")))?.reply).toBeUndefined();
  });

  it("a kept `a2a.already-answered` reply of before still replays, with its old text", async () => {
    const script = scriptOf();
    const { tasks, parts } = await setUp(script);
    const message = decide("f-1");
    await tasks.saveMessageIfAbsent({
      ...keyOf("f-1"),
      requestHash: requestHashOf("unit-workflow-start", message),
      taskId: "task-1",
      savedAt: NINE,
    });
    await tasks.saveReplyIfAbsent(keyOf("f-1"), {
      refused: "unsupported",
      code: "a2a.already-answered",
    });

    const refused = await refusedWith(followedUpTask(parts, callerOf(), message));

    expect(refused).toMatchObject({
      name: "UnsupportedOperationError",
      message: "the pause no longer waits for an answer",
      metadata: { code: "a2a.already-answered" },
    });
    expect(script.resumes).toEqual([]);
  });
});
