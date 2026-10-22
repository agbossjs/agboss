import { beforeEach, describe, expect, vi, type Mocked } from "vitest";
import {
  ActionFailedError,
  ChildExecutionFailedError,
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
} from "../../../src/index.js";
import { ExecutionCancelledError } from "../../../src/core/errors.js";
import { TestConcurrency, testWith } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  NotReservedWorkflowFinish,
  ReleaseRoomAction,
  ReleaseSeatAction,
  ReserveRoomAction,
  ReserveSeatAction,
  UndoDesk,
  UndoDeskError,
} from "./fixtures/undo.workflow.js";
import {
  UnwindApplication,
  UnwindCommittedWorkflowStart,
  UnwindGate,
  UnwindManyWorkflowStart,
  UnwindParentWorkflowStart,
  unwindSeen,
  UnwindSidePathWorkflowStart,
  UnwindWorkflowStart,
} from "./fixtures/unwind.workflow.js";

/**
 * #340 PR 3 — an execution that ends without a finish undoes its open undoable actions, newest
 * first, before it ends: a cancel of a running one (AC1), an uncaught failure, a child that fails
 * or is aborted by its launch's `FailFast` (Q2) — a failed undo of a child passing its parent's
 * boundary as it is (S5) — a body still running awaited (Q-A) or undone when it returns late
 * (Q-B); committed or already undone entries are left (AC2); the undo's signal is a clean-up one
 * (AC3); `ExecutionErrorEvent.compensations` lists what ran.
 */

const test = testWith(UnwindApplication);
const real = testWith(UnwindApplication, { concurrency: TestConcurrency.Real });

const GUEST = { guest: "ada" };
const THREAD = { threadId: "t-1" };

beforeEach(() => {
  unwindSeen.undos.length = 0;
  unwindSeen.errors.length = 0;
});

/** A gate the test opens: `wait` resolves once `open()` is called. */
function gateOf(gate: Mocked<UnwindGate>): { readonly open: () => void } {
  let open = (): void => undefined;
  gate.wait.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        open = resolve;
      }),
  );
  return {
    open: () => {
      open();
    },
  };
}

/** The ids the desk released, in order. */
const releasedIds = (desk: { release: { mock: { calls: unknown[][] } } }): unknown[] =>
  desk.release.mock.calls.map(([id]) => id);

describe("a cancel of a running execution (AC1)", () => {
  test("undoes its open actions newest first, then rejects as cancelled", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    const gate = gateOf(mockOf(UnwindGate));
    const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mockOf(UnwindGate).wait.mock.calls.length).toBeGreaterThan(0);
    });

    await app.cancel("t-1");
    gate.open();

    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    expect(
      unwindSeen.undos.map((event) => [event.compensated.component.name, event.reason]),
    ).toEqual([
      ["reserve-room-action", CompensationReason.ExecutionCancelled],
      ["hold-seat-action", CompensationReason.ExecutionCancelled],
    ]);
  });

  test("each undo runs on a clean-up signal, never the cancelled one (AC3)", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    const gate = gateOf(mockOf(UnwindGate));
    const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mockOf(UnwindGate).wait.mock.calls.length).toBeGreaterThan(0);
    });

    await app.cancel("t-1");
    gate.open();
    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);

    expect(desk.seen.mock.calls.map(([seen]) => seen.isAborted)).toEqual([false, false]);
    expect(desk.seen.mock.calls[0]?.[0].key).toMatch(/:reserve-room-action:1:compensation$/);
  });

  test("ExecutionErrorEvent.compensations lists the undo that ran", async ({ app, mockOf }) => {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    const gate = gateOf(mockOf(UnwindGate));
    const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mockOf(UnwindGate).wait.mock.calls.length).toBeGreaterThan(0);
    });

    await app.cancel("t-1");
    gate.open();
    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);

    const [failed] = unwindSeen.errors;
    expect(failed?.compensations.map((record) => [record.compensator.name, record.status])).toEqual(
      [
        ["release-room-action", CompensationStatus.Compensated],
        ["release-seat-action", CompensationStatus.Compensated],
      ],
    );
  });
});

describe("what is committed or already undone is left (AC2)", () => {
  test("a committed seat: only the room is undone", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    const gate = gateOf(mockOf(UnwindGate));
    const run = execute(app, UnwindCommittedWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mockOf(UnwindGate).wait.mock.calls.length).toBeGreaterThan(0);
    });

    await app.cancel("t-1");
    gate.open();

    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(releasedIds(desk)).toEqual(["room-1"]);
  });

  test("undone on a side path, then cancelled: each undo ran once", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));
    const gate = gateOf(mockOf(UnwindGate));
    const run = execute(app, UnwindSidePathWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(mockOf(UnwindGate).wait.mock.calls.length).toBeGreaterThan(0);
    });

    await app.cancel("t-1");
    gate.open();

    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    expect(unwindSeen.undos.map((event) => event.reason)).toEqual([]);
  });
});

describe("an uncaught failure", () => {
  test("undoes the open actions, then fails with the step's error", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("gate broke"));

    const run = execute(app, UnwindWorkflowStart, GUEST);

    await expect(run).rejects.toFailWith(ActionFailedError, { cause: UndoDeskError });
    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    expect(unwindSeen.undos.map((event) => event.reason)).toEqual([
      CompensationReason.ExecutionFailed,
      CompensationReason.ExecutionFailed,
    ]);
  });

  test("a failed undo: the older still runs, then CompensationFailedError", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.release.mockRejectedValueOnce(new UndoDeskError("room desk down"));
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("gate broke"));

    const run = execute(app, UnwindWorkflowStart, GUEST);

    await expect(run).rejects.toFailWith(CompensationFailedError, { cause: ActionFailedError });
    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    expect(unwindSeen.errors[0]?.error).toBeInstanceOf(CompensationFailedError);
  });
});

describe("a body still running when the execution ends (Q-A, Q-B)", () => {
  test("one that returns before the undo ends is undone too", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    let roomReserved = (): void => undefined;
    desk.reserve.mockImplementation((kind: string) =>
      kind === "room"
        ? new Promise<string>((resolve) => {
            roomReserved = () => {
              resolve("room-1");
            };
          })
        : Promise.resolve("seat-1"),
    );
    const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(desk.reserve.mock.calls).toHaveLength(2);
    });

    await app.cancel("t-1");
    await vi.waitFor(() => {
      expect(unwindSeen.errors).toHaveLength(0);
    });
    roomReserved();

    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
  });

  test("one that returns after the undo ended is undone at once, in process", async ({
    app,
    mockOf,
    clock,
  }) => {
    const desk = mockOf(UndoDesk);
    let roomReserved = (): void => undefined;
    desk.reserve.mockImplementation((kind: string) =>
      kind === "room"
        ? new Promise<string>((resolve) => {
            roomReserved = () => {
              resolve("room-1");
            };
          })
        : Promise.resolve("seat-1"),
    );
    const run = execute(app, UnwindWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(desk.reserve.mock.calls).toHaveLength(2);
    });
    await app.cancel("t-1");
    await clock.advance(seconds(5));
    await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(releasedIds(desk)).toEqual(["seat-1"]);

    roomReserved();

    await vi.waitFor(() => {
      expect(releasedIds(desk)).toEqual(["seat-1", "room-1"]);
    });
  });
});

describe("a child that ends without a finish (Q2, S5)", () => {
  real(
    "a FailFast sibling: each child undoes its own room, then the launch fails",
    async ({ app, mockOf }) => {
      const desk = mockOf(UndoDesk);
      let rooms = 0;
      desk.reserve.mockImplementation(() => Promise.resolve(`room-${String((rooms += 1))}`));
      mockOf(UnwindGate).wait.mockImplementation(
        (guest: string, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            if (guest === "bob") {
              setTimeout(() => {
                reject(new UndoDeskError("bob's gate broke"));
              }, 20);
            }
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      );

      const run = execute(app, UnwindManyWorkflowStart, [{ guest: "ada" }, { guest: "bob" }]);

      await expect(run).rejects.toFailWith(ChildExecutionFailedError, { cause: ActionFailedError });
      expect([...releasedIds(desk)].sort()).toEqual(["room-1", "room-2"]);
      expect(unwindSeen.undos.map((event) => event.reason).sort()).toEqual([
        CompensationReason.ExecutionCancelled,
        CompensationReason.ExecutionFailed,
      ]);
    },
  );

  test("a failed child is undone before its parent's side path takes it", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("gate broke"));

    const result = await execute(app, UnwindParentWorkflowStart, GUEST);

    expect(result).toFinishWith(NotReservedWorkflowFinish, GUEST);
    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    expect(result).toHaveCompensated(ReserveRoomAction, {
      by: ReleaseRoomAction,
      reason: CompensationReason.ExecutionFailed,
    });
    expect(result).toHaveCompensated(ReserveSeatAction, {
      by: ReleaseSeatAction,
      reason: CompensationReason.SidePath,
    });
  });

  test("a child's failed undo passes the parent's boundary as it is: the parent undoes its own", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.release.mockRejectedValueOnce(new UndoDeskError("room desk down"));
    mockOf(UnwindGate).wait.mockRejectedValue(new UndoDeskError("gate broke"));

    const run = execute(app, UnwindParentWorkflowStart, GUEST);

    await expect(run).rejects.toBeInstanceOf(CompensationFailedError);
    await expect(run).rejects.not.toBeInstanceOf(ChildExecutionFailedError);
    expect(releasedIds(desk)).toEqual(["room-1", "seat-1"]);
    expect(unwindSeen.undos.at(-1)?.reason).toBe(CompensationReason.ExecutionFailed);
  });
});
