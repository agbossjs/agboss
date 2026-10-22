import { beforeEach, describe, expect, vi } from "vitest";
import {
  ActionFailedError,
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
} from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { seconds } from "../../../src/units/index.js";
import {
  ChargeCardAction,
  NotReservedWorkflowFinish,
  ReleaseRoomAction,
  ReleaseSeatAction,
  ReserveRoomAction,
  ReserveSeatAction,
  ReservedWorkflowFinish,
  UndoApplication,
  UndoDesk,
  UndoDeskError,
  undoEvents,
  UndoQuickApplication,
  UndoUnhandledWorkflowStart,
  UndoWorkflowStart,
} from "./fixtures/undo.workflow.js";

/**
 * #340 PR 2 — a failed join undoes its finished undoable branches (Q3, `JoinFailed`): newest first,
 * each in its own frame on a clean-up signal bounded by `compensationTimeout`, before the
 * `.onJoinError` side path runs or the branch's error fails the execution; an undo that fails does
 * not stop the others, then `CompensationFailedError` (Q4), which no side path takes.
 */

const test = testWith(UndoApplication);
const quick = testWith(UndoQuickApplication);

const GUEST = { guest: "ada" };

beforeEach(() => {
  undoEvents.length = 0;
});

describe("a failed join undoes its finished branches", () => {
  test("newest first, before the side path, each recorded", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));

    const result = await execute(app, UndoWorkflowStart, GUEST);

    expect(result).toFinishWith(NotReservedWorkflowFinish, GUEST);
    const [room] = desk.release.mock.invocationCallOrder;
    const [, seat] = desk.release.mock.invocationCallOrder;
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
    expect(room).toBeLessThan(seat ?? 0);
    expect(result).toHaveCompensated(ReserveRoomAction, {
      by: ReleaseRoomAction,
      reason: CompensationReason.JoinFailed,
    });
    expect(result).toHaveCompensated(ReserveSeatAction, { by: ReleaseSeatAction });
    expect(result).toHaveHandledError(UndoDeskError, { at: ChargeCardAction });
    expect(result.compensations.map((record) => record.compensator.name)).toEqual([
      "release-room-action",
      "release-seat-action",
    ]);
  });

  test("each undo runs in its own frame: its key, the step it undoes, a live signal", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));

    const result = await execute(app, UndoWorkflowStart, GUEST);

    const seatKey = `${result.executionId}:reserve-seat-action:1`;
    expect(desk.seen.mock.calls.map(([seen]) => seen)).toContainEqual({
      key: `${seatKey}:compensation`,
      compensates: seatKey,
      isAborted: false,
    });
    expect(result.compensations[1]?.compensated).toMatchObject({
      idempotencyKey: seatKey,
      component: { name: "reserve-seat-action" },
    });
  });

  test("onCompensationStart / onCompensationEnd around each undo", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));

    await execute(app, UndoWorkflowStart, GUEST);

    expect(
      undoEvents.map((event) => ({
        step: event.step.component.name,
        compensated: event.compensated.component.name,
        reason: event.reason,
        status: "status" in event ? event.status : undefined,
      })),
    ).toEqual([
      ...["start", "end"].map((moment) => ({
        step: "release-room-action",
        compensated: "reserve-room-action",
        reason: CompensationReason.JoinFailed,
        status: moment === "end" ? CompensationStatus.Compensated : undefined,
      })),
      ...["start", "end"].map((moment) => ({
        step: "release-seat-action",
        compensated: "reserve-seat-action",
        reason: CompensationReason.JoinFailed,
        status: moment === "end" ? CompensationStatus.Compensated : undefined,
      })),
    ]);
  });

  test("an undo's spend is the execution's: its service under the undo action", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));

    const result = await execute(app, UndoWorkflowStart, GUEST);

    expect(result.spend.byCaller["action:release-seat-action"]).toBeCloseTo(0.001);
  });

  test("no side path: undone, then the execution fails with the branch's error", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));

    const run = execute(app, UndoUnhandledWorkflowStart, GUEST);

    await expect(run).rejects.toFailWith(ActionFailedError, { cause: UndoDeskError });
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
  });

  test("every branch finished: nothing is undone, the finish commits them", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    const result = await execute(app, UndoWorkflowStart, GUEST);

    expect(result).toFinishWith(ReservedWorkflowFinish, { summary: "seat-1 + room-1" });
    expect(result.compensations).toEqual([]);
    expect(desk.release.mock.calls).toHaveLength(0);
  });
});

describe("an undo that fails (Q4)", () => {
  test("the rest still runs, then CompensationFailedError — never the side path", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));
    desk.release.mockRejectedValueOnce(new UndoDeskError("room desk down"));

    const run = execute(app, UndoWorkflowStart, GUEST);

    await expect(run).rejects.toFailWith(CompensationFailedError, {
      failures: [
        {
          compensated: expect.objectContaining({
            component: expect.objectContaining({ name: "reserve-room-action" }) as unknown,
          }) as unknown,
          status: CompensationStatus.Failed,
          reason: CompensationReason.JoinFailed,
        },
      ],
      cause: ActionFailedError,
    });
    await expect(run).rejects.toFailWith(UndoDeskError);
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
  });
});

describe("the clean-up signal (AC3)", () => {
  quick(
    "an undo's signal aborts after compensationTimeout; the undo fails with it",
    async ({ app, mockOf, clock }) => {
      const desk = mockOf(UndoDesk);
      desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
      desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
      desk.charge.mockRejectedValue(new UndoDeskError("card declined"));
      desk.release.mockImplementation(
        (_id: string, _key: string, signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(signal.reason as Error);
            });
          }),
      );

      const run = execute(app, UndoWorkflowStart, GUEST);
      // observed at once: it rejects while the test still moves the clock
      run.catch(() => undefined);
      await vi.waitFor(() => {
        expect(desk.release.mock.calls).toHaveLength(1);
      });
      await clock.advance(seconds(2));
      await vi.waitFor(() => {
        expect(desk.release.mock.calls).toHaveLength(2);
      });
      await clock.advance(seconds(2));

      await expect(run).rejects.toFailWith(CompensationFailedError, {
        failures: [
          expect.objectContaining({ status: CompensationStatus.Failed }) as unknown,
          expect.objectContaining({ status: CompensationStatus.Failed }) as unknown,
        ],
      });
      expect(desk.seen.mock.calls.map(([seen]) => seen.isAborted)).toEqual([false, false]);
    },
  );
});
