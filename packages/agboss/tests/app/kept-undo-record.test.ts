/**
 * #635 — a root's kept record (`ExecutionHistoryRecord.compensations`, what `agboss records export`
 * writes) lists every undo action that ran, as its `onExecutionError` does, however the tree ended:
 * a pass's own failure, a failed undo, a cancel of the running tree, a side path's undo before the
 * failure, a failed per-item child, a cancel of the paused tree, a cancel request seen at rest. The
 * takeover rows are in `kept-undo-takeover.test.ts`.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { CompensationFailedError } from "../../src/index.js";
import {
  ExecutionTreeRepository,
  InMemoryExecutionTreeRepository,
} from "../../src/infrastructure/execution-tree.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { UndoDesk, UndoDeskError } from "../flow/runtime/fixtures/undo.workflow.js";
import {
  AskGuestTool,
  GuestAgent,
  UnwindGuestWorkflowStart,
} from "../flow/runtime/fixtures/unwind-pause.workflow.js";
import {
  unwindSeen,
  UnwindGate,
  UnwindManyWorkflowStart,
  UnwindSidePathWorkflowStart,
  UnwindWorkflowStart,
} from "../flow/runtime/fixtures/unwind.workflow.js";
import { KeptUndoApplication } from "./fixtures/kept-undo.application.js";
import {
  GUEST,
  heldUntilAborted,
  keptAsTheEvent,
  ROOM,
  SEAT,
  THREAD,
  resetKeptUndo,
} from "./fixtures/kept-undo.js";

const test = testWith(KeptUndoApplication);

beforeEach(resetKeptUndo);

describe("#635: a root's kept record lists every undo that ran, as its error event does", () => {
  test("its pass fails: the room and the seat undone", async ({ app, mockOf }) => {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));

    await expect(execute(app, UnwindWorkflowStart, GUEST, THREAD)).rejects.toThrow(
      "the gate is down",
    );

    expect(await keptAsTheEvent(app, "failed")).toEqual([ROOM, SEAT]);
  });

  test("its pass fails and an undo fails: both listed, the failed one failed", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.release.mockImplementation((id: string) =>
      id === "seat-1" ? Promise.reject(new Error("seat desk down")) : Promise.resolve(),
    );
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));

    const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);

    await expect(run).rejects.toBeInstanceOf(CompensationFailedError);
    expect(await keptAsTheEvent(app, "failed")).toEqual([ROOM, "release-seat-action failed"]);
  });

  test("the running tree is cancelled: both undone, the record cancelled", async ({
    app,
    mockOf,
  }) => {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockOf(UnwindGate).wait.mockImplementation(heldUntilAborted);
    const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mockOf(UnwindGate).wait.mock.calls.length).toBeGreaterThan(0);
    });

    await app.cancel("t-1");

    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(await keptAsTheEvent(app, "cancelled")).toEqual([ROOM, SEAT]);
  });

  test("a side path undid both, then the tree fails: its undos listed", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("the gate is down"));

    await expect(execute(app, UnwindSidePathWorkflowStart, GUEST, THREAD)).rejects.toThrow(
      "the gate is down",
    );

    expect(await keptAsTheEvent(app, "failed")).toEqual([ROOM, SEAT]);
  });

  test("a per-item child fails: the child's room undone, listed by the child", async ({
    app,
    mockOf,
  }) => {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockOf(UnwindGate).wait.mockImplementation((guest: string, signal: AbortSignal) =>
      guest === "bob"
        ? Promise.reject(new UndoDeskError("bob's gate is down"))
        : heldUntilAborted(guest, signal),
    );

    const run = execute(app, UnwindManyWorkflowStart, [{ guest: "bob" }, GUEST], THREAD);

    await expect(run).rejects.toThrow();
    // the failed child undid its own room in its node — its error event lists it, the root's
    // nothing; its sibling never started (one branch at a time)
    expect(await keptAsTheEvent(app, "failed")).toEqual([]);
    const children = unwindSeen.errors.filter((error) => error.parentExecutionId !== undefined);
    expect(
      children.map((child) => child.compensations.map((undo) => undo.compensator.name)),
    ).toEqual([["release-room-action"]]);
  });

  test("the paused tree is cancelled: its room undone", async ({ app, mockLlm, mockOf }) => {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockLlm(GuestAgent).thenReturn(callTool(AskGuestTool, GUEST));
    await execute(app, UnwindGuestWorkflowStart, GUEST, THREAD);

    await app.cancel("t-1");

    expect(await keptAsTheEvent(app, "cancelled")).toEqual([ROOM]);
  });

  test("a cancel requested while the pass ran, seen at rest: its room undone", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockLlm(GuestAgent).thenReturn(callTool(AskGuestTool, GUEST));
    // the request appears once the pass stored its paused run: only the check at rest sees it
    const saves = vi.spyOn(InMemoryPausedExecutionRepository.prototype, "save");
    await app.ready();
    const trees = app.resolve(ExecutionTreeRepository);
    vi.spyOn(trees, "findByIdInTree").mockImplementation((tree, key) => {
      if (key === "@agboss/cancel-request" && saves.mock.calls.length > 0)
        return Promise.resolve({ requestedAt: "now", ownerId: null });
      return InMemoryExecutionTreeRepository.prototype.findByIdInTree.call(trees, tree, key);
    });

    const run = execute(app, UnwindGuestWorkflowStart, GUEST, THREAD);

    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(await keptAsTheEvent(app, "cancelled")).toEqual([ROOM]);
  });
});
