import { ExecutionError } from "../../../src/core/error-families/run-errors.js";
import { describe, expect, type Mocked } from "vitest";
import { CompensationReason } from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  BookRoomAction,
  BookSeatAction,
  FreeRoomAction,
  FreeSeatAction,
  TripBookingDesk,
  ChargedTripWorkflowStart,
  ChildUndoApplication,
  CommitTripWorkflowStart,
  DeclinedTripWorkflowStart,
  NestedChargedTripWorkflowStart,
  NestedQuorumTripWorkflowStart,
  QuorumTripWorkflowStart,
  RemoteChargedTripWorkflowStart,
  RemoteQuorumTripWorkflowStart,
  RefusedTripWorkflowStart,
  TripBookedWorkflowFinish,
  TripNotReservedWorkflowFinish,
  TripDesk,
  TripReviewedWorkflowFinish,
} from "../fixtures/child-undo.fixture.js";

/**
 * #1281b (D8) — a child's undoable actions bubble up to its parent: the child's finish commits
 * none of them; its parent's finish commits them, and an unwind of the parent — a quorum that went
 * on without the child's branch, the parent's own failure — undoes them, newest first, once each by
 * their compensation keys, in the child's workflow; two levels up too, and from a child on any
 * instance.
 */

const test = testWith(ChildUndoApplication);
const GUEST = { guest: "ada" };

/** Reservations named by kind; the ids each release got, in order. */
function deskOf(desk: Mocked<TripBookingDesk>): () => readonly unknown[] {
  desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
  return () => desk.release.mock.calls.map(([id]) => id);
}

describe("#1281b: a quorum that goes on without a child's branch undoes what the child did", () => {
  test("both of the child's reservations are released once, newest first", async ({
    app,
    mockService,
  }) => {
    const released = deskOf(mockService(TripBookingDesk));

    const result = await execute(app, QuorumTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripReviewedWorkflowFinish, { summary: "reviewed" });
    expect(released()).toEqual(["room-1", "seat-1"]);
    expect(result).toHaveCompensated(BookRoomAction, {
      by: FreeRoomAction,
      reason: CompensationReason.QuorumExcluded,
    });
    expect(result).toHaveCompensated(BookSeatAction, {
      by: FreeSeatAction,
      reason: CompensationReason.QuorumExcluded,
    });
    expect(result.compensations).toHaveLength(2);
  });

  test("two levels up: the grandchild's reservations are undone by the root's quorum", async ({
    app,
    mockService,
  }) => {
    const released = deskOf(mockService(TripBookingDesk));

    const result = await execute(app, NestedQuorumTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripReviewedWorkflowFinish, { summary: "reviewed" });
    expect(released()).toEqual(["room-1", "seat-1"]);
    expect(result.compensations.map((record) => record.reason)).toEqual([
      CompensationReason.QuorumExcluded,
      CompensationReason.QuorumExcluded,
    ]);
  });

  test("a child on any instance: its moved entries come back with its finish", async ({
    app,
    mockService,
  }) => {
    const released = deskOf(mockService(TripBookingDesk));

    const result = await execute(app, RemoteQuorumTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripReviewedWorkflowFinish, { summary: "reviewed" });
    expect(released()).toEqual(["room-1", "seat-1"]);
    expect(result.compensations).toHaveLength(2);
  });
});

describe("#1281b: a quorum not reached undoes what its child branch did", () => {
  test("both reservations released once before .onError, as a failed join's", async ({
    app,
    mockService,
  }) => {
    const released = deskOf(mockService(TripBookingDesk));

    const result = await execute(app, RefusedTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripNotReservedWorkflowFinish, GUEST);
    expect(released()).toEqual(["room-1", "seat-1"]);
    expect(result.compensations.map((record) => record.reason)).toEqual([
      CompensationReason.JoinFailed,
      CompensationReason.JoinFailed,
    ]);
  });
});

describe("#1281b: the parent's finish commits what its child moved up", () => {
  test("nothing is undone", async ({ app, mockService }) => {
    const released = deskOf(mockService(TripBookingDesk));

    const result = await execute(app, CommitTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripBookedWorkflowFinish, { tripId: "seat-1+room-1" });
    expect(released()).toEqual([]);
    expect(result.compensations).toEqual([]);
  });
});

describe("#1281b: a parent that fails after its child finished undoes what the child did", () => {
  for (const [title, start] of [
    ["one level", ChargedTripWorkflowStart],
    ["two levels", NestedChargedTripWorkflowStart],
    ["a child on any instance", RemoteChargedTripWorkflowStart],
  ] as const) {
    test(`${title}: each reservation released once, newest first`, async ({ app, mockService }) => {
      const released = deskOf(mockService(TripBookingDesk));
      mockService(TripDesk).charge.mockRejectedValue(new Error("the card is declined"));

      await expect(execute(app, start, GUEST)).rejects.toThrow("the card is declined");

      expect(released()).toEqual(["room-1", "seat-1"]);
    });
  }

  test("a failed undo of a moved entry fails the parent with ExecutionError.CompensationFailed", async ({
    app,
    mockService,
  }) => {
    const desk = mockService(TripBookingDesk);
    deskOf(desk);
    desk.release.mockRejectedValue(new Error("the desk is down"));

    await expect(execute(app, QuorumTripWorkflowStart, GUEST)).rejects.toMatchObject({
      code: "execution.compensation-failed",
    });
    // each once at the join, never again by the failed execution's own unwind
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
  });
});

describe("#1281 (10): a step's failure an .onError takes undoes what the child held, before the side path", () => {
  test("each reservation is released once, newest first, never committed", async ({
    app,
    mockService,
  }) => {
    const released = deskOf(mockService(TripBookingDesk));
    mockService(TripDesk).charge.mockRejectedValue(new Error("the card is declined"));

    const result = await execute(app, DeclinedTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripNotReservedWorkflowFinish, GUEST);
    expect(released()).toEqual(["room-1", "seat-1"]);
    expect(result.compensations.map((record) => record.reason)).toEqual([
      CompensationReason.StepFailed,
      CompensationReason.StepFailed,
    ]);
    expect(result).toHaveCompensated(BookSeatAction, {
      by: FreeSeatAction,
      reason: CompensationReason.StepFailed,
    });
  });

  test("a step that succeeds leaves the child's entries to the finish: nothing is undone", async ({
    app,
    mockService,
  }) => {
    const released = deskOf(mockService(TripBookingDesk));

    await execute(app, CommitTripWorkflowStart, GUEST);

    expect(released()).toEqual([]);
  });
});
