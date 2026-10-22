import { beforeEach, describe, expect, vi } from "vitest";
import { CompensationReason, NotPausedError } from "../../src/index.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { UndoDesk } from "../flow/runtime/fixtures/undo.workflow.js";
import {
  AskGuestTool,
  GuestAgent,
  UnwindGuestWorkflowStart,
  UnwindPauseApplication,
  UnwindPausedWorkflowStart,
} from "../flow/runtime/fixtures/unwind-pause.workflow.js";
import {
  UnwindApplication,
  UnwindGate,
  unwindSeen,
  UnwindWorkflowStart,
} from "../flow/runtime/fixtures/unwind.workflow.js";

/**
 * #340 PR 3 — `app.cancel` and the automatic undo: a tree resting paused is withdrawn, undone and
 * cancelled before the call returns (Q6) — a paused child's own actions too, read from its
 * checkpoint; a cancel from another instance (#360) of a running tree returns once recorded and its
 * holder undoes it before the tree ends.
 */

const test = testWith(UnwindPauseApplication);
const pair = testWith(UnwindApplication, { instances: 2 });

const GUEST = { guest: "ada" };
const THREAD = { threadId: "t-1" };

beforeEach(() => {
  unwindSeen.undos.length = 0;
  unwindSeen.errors.length = 0;
});

const releasedIds = (desk: { release: { mock: { calls: unknown[][] } } }): unknown[] =>
  desk.release.mock.calls.map(([id]) => id);

describe("a cancel of a paused tree (Q6)", () => {
  test("withdraws the pause, undoes, then returns cancelled", async ({ app, mockLlm, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockLlm(GuestAgent).thenReturn(callTool(AskGuestTool, GUEST));
    const paused = await execute(app, UnwindGuestWorkflowStart, GUEST, THREAD);
    expect(paused.pending).toHaveLength(1);

    const cancel = await app.cancel("t-1");

    expect(cancel).toEqual({ cancelled: true });
    expect(releasedIds(desk)).toEqual(["room-1"]);
    expect(unwindSeen.undos.map((event) => event.reason)).toEqual([
      CompensationReason.ExecutionCancelled,
    ]);
    const [failed] = unwindSeen.errors;
    expect(failed?.error).toBeInstanceOf(ExecutionCancelledError);
    expect(failed?.compensations.map((record) => record.compensator.name)).toEqual([
      "release-room-action",
    ]);
    await expect(app.resume(answerOf(paused, { approved: true }))).rejects.toBeInstanceOf(
      NotPausedError,
    );
  });

  test("a paused child's actions are undone with its parent's, newest first", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockLlm(GuestAgent).thenReturn(callTool(AskGuestTool, GUEST));
    const paused = await execute(app, UnwindPausedWorkflowStart, GUEST, THREAD);
    expect(paused.pending).toHaveLength(1);

    await app.cancel("t-1");

    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    const [room] = unwindSeen.undos;
    expect(room?.executionId).not.toBe(paused.executionId);
    expect(room?.step.idempotencyKey).toBe(
      `${room?.compensated.idempotencyKey ?? ""}:compensation`,
    );
  });

  test("an undo that fails: still cancelled, the error event says why", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.release.mockRejectedValue(new Error("room desk down"));
    mockLlm(GuestAgent).thenReturn(callTool(AskGuestTool, GUEST));
    await execute(app, UnwindGuestWorkflowStart, GUEST, THREAD);

    const cancel = await app.cancel("t-1");

    expect(cancel).toEqual({ cancelled: true });
    expect(unwindSeen.errors[0]?.error.name).toBe("CompensationFailedError");
  });
});

/** The two instances of a test, ready. */
async function both(apps: readonly TestApp[]): Promise<readonly [TestApp, TestApp]> {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  await first.ready();
  await second.ready();
  return [first, second];
}

describe("a cancel from another instance (#360)", () => {
  pair(
    "returns once recorded; the holder undoes before the tree ends",
    async ({ apps, clock, mockOf }) => {
      const desk = mockOf(UndoDesk);
      desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
      let open = (): void => undefined;
      mockOf(UnwindGate).wait.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            open = resolve;
          }),
      );
      const [first, second] = await both(apps);
      const run = execute(first, UnwindWorkflowStart, GUEST, THREAD);
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(mockOf(UnwindGate).wait.mock.calls.length).toBeGreaterThan(0);
      });

      const cancel = await second.cancel("t-1");
      expect(cancel).toEqual({ cancelled: true });
      await clock.advance(seconds(10));
      open();

      await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
      expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    },
  );
});
