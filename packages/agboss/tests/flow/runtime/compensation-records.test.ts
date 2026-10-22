import { describe, expect, it } from "vitest";
import {
  CompensationFailedError,
  CompensationReason,
  CompensationStatus,
  type CompensationRecord,
} from "../../../src/index.js";
import {
  CompensationEntryStatus,
  mergeCompensations,
  type CompensationEntry,
} from "../../../src/flow/compensation.js";
import { CompensationRegistry } from "../../../src/flow/runtime/compensation/registry.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  HoldSeatAction,
  NotReservedWorkflowFinish,
  NotifyDeskAction,
  ReleaseRoomAction,
  ReleaseSeatAction,
  ReserveRoomAction,
  SeatConfirmedWorkflowFinish,
  UndoApplication,
  UndoDesk,
  UndoDeskError,
  UndoPathWorkflowStart,
} from "./fixtures/undo.workflow.js";

/**
 * #340 PR 2 — the `compensations` records: an undoable action opens one, its committer or a finish
 * commits it, an undo action on a side path closes the newest open one it undoes
 * (`CompensationReason.SidePath`, `Compensated` or `Failed`); `result.compensations` and
 * `result.record.compensations` list the undo actions that ran, in the order they ended.
 */

const test = testWith(UndoApplication);

const GUEST = { guest: "ada" };

describe("records on the path", () => {
  test("the committer commits the seat, the finish the room: nothing undone", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    const result = await execute(app, UndoPathWorkflowStart, GUEST, { record: true });

    expect(result).toFinishWith(SeatConfirmedWorkflowFinish, { seatId: "seat-1" });
    expect(result.compensations).toEqual([]);
    expect(result.record?.compensations).toEqual([]);
  });

  test("a side path's undo actions close the records, newest first", async ({ app, mockOf }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));

    const result = await execute(app, UndoPathWorkflowStart, GUEST, { record: true });

    expect(result).toFinishWith(NotReservedWorkflowFinish, GUEST);
    expect(result).toHaveCompensated(ReserveRoomAction, {
      by: ReleaseRoomAction,
      reason: CompensationReason.SidePath,
    });
    expect(result).toHaveCompensated(HoldSeatAction, { by: ReleaseSeatAction });
    expect(result.record?.compensations).toEqual(result.compensations);
    expect(result.compensations.map((record) => record.compensator.name)).toEqual([
      "release-room-action",
      "release-seat-action",
    ]);
    // an undo on a side path keeps its own visit's key, and undoes nothing automatically
    expect(desk.seen.mock.calls.map(([seen]) => seen)).toEqual([
      {
        key: `${result.executionId}:release-room-action:1`,
        compensates: undefined,
        isAborted: false,
      },
      {
        key: `${result.executionId}:release-seat-action:1`,
        compensates: undefined,
        isAborted: false,
      },
    ]);
  });

  test("an undo whose failure its own side path takes is recorded Failed", async ({
    app,
    mockOf,
    mockAction,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.charge.mockRejectedValue(new UndoDeskError("card declined"));
    desk.release.mockResolvedValueOnce().mockRejectedValueOnce(new UndoDeskError("seat desk down"));

    const result = await execute(app, UndoPathWorkflowStart, GUEST);

    expect(mockAction(NotifyDeskAction)).toHaveBeenCalledTimes(1);
    expect(result).toHaveCompensated(HoldSeatAction, {
      by: ReleaseSeatAction,
      status: CompensationStatus.Failed,
    });
    expect(result).not.toHaveCompensated(HoldSeatAction, { by: ReleaseSeatAction });
    expect(result.compensations[1]?.error).toMatchObject({ name: "ActionFailedError" });
  });
});

describe("the channel and the registry", () => {
  const entry = (key: string, sequence: number): CompensationEntry => ({
    key,
    executionId: "execution-1",
    sequence,
    action: "reserve-room-action",
    compensated: {
      component: bareRecordOf("reserve-room-action", ComponentKind.Action),
      nodeId: "reserve-room-action",
      visitNumber: 1,
      idempotencyKey: key,
      callId: undefined,
      itemIndex: undefined,
      copyNumber: 1,
      toolLoopIteration: undefined,
      validationAttempts: 0,
    },
    compensator: "release-room-action",
    input: {},
    status: CompensationEntryStatus.Open,
  });
  const tree = { tenantId: "default", rootExecutionId: "execution-1" };

  it("an entry written again replaces the older one and moves to the end", () => {
    const closed = { ...entry("a", 1), status: CompensationEntryStatus.Committed };

    expect(mergeCompensations([entry("a", 1), entry("b", 2)], [closed])).toEqual([
      entry("b", 2),
      closed,
    ]);
  });

  it("counts the tree's order across its branches, after what its state knows", () => {
    const registry = new CompensationRegistry();

    expect([registry.nextSequence(tree, 3), registry.nextSequence(tree, 3)]).toEqual([4, 5]);
    registry.write(tree, [entry("a", 4)]);
    expect(registry.entriesOf(tree, () => true)).toEqual([entry("a", 4)]);
    registry.forget(tree);
    expect([registry.entriesOf(tree, () => true), registry.nextSequence(tree, 0)]).toEqual([[], 1]);
  });

  it("CompensationFailedError names each failed undo and keeps the cause", () => {
    const failure: CompensationRecord = {
      compensated: entry("a", 1).compensated,
      compensator: bareRecordOf("release-room-action", ComponentKind.Action),
      reason: CompensationReason.JoinFailed,
      status: CompensationStatus.Failed,
      startedAt: "2026-01-05T09:00:00.000Z",
      endedAt: "2026-01-05T09:00:00.000Z",
    };
    const cause = new Error("card declined");

    const error = new CompensationFailedError([failure], cause);

    expect([error.code, error.cause, error.failures]).toEqual([
      "compensation.failed",
      cause,
      [failure],
    ]);
    expect(error.message).toContain(
      "release-room-action (compensates reserve-room-action): failed",
    );
  });
});
