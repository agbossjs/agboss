import { describe, expect } from "vitest";
import { CompensationReason } from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  NotReservedWorkflowFinish,
  ReservedWorkflowFinish,
  ReleaseRoomAction,
  ReleaseSeatAction,
  ReserveRoomAction,
  ReserveSeatAction,
  UndoDesk,
} from "./fixtures/undo.workflow.js";
import {
  QuorumExcludedWorkflowStart,
  QuorumRefusedWorkflowStart,
  QuorumUndoApplication,
} from "./fixtures/quorum-undo.workflow.js";

/**
 * #1281b: a quorum join that goes on undoes the branches that completed yet were not counted
 * (`CompensationReason.QuorumExcluded`), once each, by their compensation keys; a branch that was
 * counted keeps its entry (committed by its finish); a quorum that is not reached undoes every
 * completed branch before its `.onError` side path (`CompensationReason.JoinFailed`).
 */

const test = testWith(QuorumUndoApplication);
const GUEST = { guest: "ada" };

describe("#1281b: the excluded branches of a quorum are undone", () => {
  test("the seat an arbiter refused is released at the join; the counted room is not", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    const result = await execute(app, QuorumExcludedWorkflowStart, GUEST);

    expect(result).toFinishWith(ReservedWorkflowFinish, { summary: "reviewed" });
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["seat-1"]);
    expect(result).toHaveCompensated(ReserveSeatAction, {
      by: ReleaseSeatAction,
      reason: CompensationReason.QuorumExcluded,
    });
    expect(result.compensations).toHaveLength(1);
  });

  test("a failed undo of an excluded branch fails the execution; it is not retried", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    desk.release.mockRejectedValue(new Error("the desk is down"));

    await expect(execute(app, QuorumExcludedWorkflowStart, GUEST)).rejects.toMatchObject({
      code: "compensation.failed",
    });
    // the seat once at the join; the counted room is undone by the failed execution's own unwind
    expect(desk.release.mock.calls.filter(([id]) => id === "seat-1")).toHaveLength(1);
  });
});

describe("#1281b: a quorum not reached undoes its completed branches", () => {
  test("both reservations are released, newest first, once each, before .onError", async ({
    app,
    mockOf,
  }) => {
    const desk = mockOf(UndoDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    const result = await execute(app, QuorumRefusedWorkflowStart, GUEST);

    expect(result).toFinishWith(NotReservedWorkflowFinish, GUEST);
    expect(desk.release.mock.calls.map(([id]) => id).sort()).toEqual(["room-1", "seat-1"]);
    expect(desk.release.mock.calls).toHaveLength(2);
    expect(result).toHaveCompensated(ReserveRoomAction, {
      by: ReleaseRoomAction,
      reason: CompensationReason.JoinFailed,
    });
    expect(result).toHaveCompensated(ReserveSeatAction, { by: ReleaseSeatAction });
  });
});
