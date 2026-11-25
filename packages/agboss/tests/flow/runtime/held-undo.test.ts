import { StepError } from "../../../src/core/error-families/step-errors.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { beforeEach, describe, expect } from "vitest";
import { CompensationReason } from "../../../src/index.js";
import { decideWith, testWith } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { TestExecutionBudget } from "../fixtures/budgets.js";
import { execute } from "../../helpers/flow.js";
import {
  BookSeatAction,
  FreeSeatAction,
  TripBookingDesk,
  TripDesk,
  TripNotReservedWorkflowFinish,
} from "../fixtures/child-undo.fixture.js";
import {
  ArbiterOutOfBudgetWorkflowStart,
  AskingSeatArbiter,
  ArbiterThrowsChildWorkflowStart,
  ArbiterThrowsWorkflowStart,
  HeldUndoApplication,
  JoinDeclinedTripWorkflowStart,
  QuorumMissedTripWorkflowStart,
  TooManyCarsTripWorkflowStart,
  undoReasons,
} from "./fixtures/held-undo.workflow.js";

/**
 * #1281 — nothing a launch did is left undone by the way it failed:
 * - an arbiter that throws, or whose model call meets a spent budget, on the answer of a branch
 *   whose undoable action (or child workflow) succeeded fails that branch with its entries open: the
 *   join undoes them (`CompensationReason.JoinFailed`) — before, the entry was never written and the
 *   reservation stayed for good;
 * - a join that fails into its `.onError` — a failed branch, a quorum not reached, a list past
 *   `maxItems` — undoes what an earlier child left open first (`CompensationReason.StepFailed`), as
 *   a plain step's failure does (#1281 (10)) — before, the side path's finish committed it.
 */

const test = testWith(HeldUndoApplication);
const GUEST = { guest: "ada" };

beforeEach(() => {
  undoReasons.length = 0;
});

const released = (desk: { release: { mock: { calls: unknown[][] } } }): unknown[] =>
  desk.release.mock.calls.map(([id]) => id).sort();

const reservedOf = (desk: { reserve: { mock: { calls: string[][] } } }): string[] =>
  desk.reserve.mock.calls.map(([kind]) => `${kind ?? ""}-1`).sort();

describe("#1281: an arbiter that fails a branch after its node answered", () => {
  test("a throw on an undoable action's answer: the seat is released by the join", async ({
    app,
    mockService,
  }) => {
    const desk = mockService(TripBookingDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    await expect(execute(app, ArbiterThrowsWorkflowStart, GUEST)).rejects.toBeInstanceOf(
      StepError.Arbiter,
    );

    // the room's branch was cancelled by the seat's failure, or finished and undone with it
    expect(released(desk)).toEqual(reservedOf(desk));
    expect(released(desk)).toContain("seat-1");
    expect(new Set(undoReasons)).toEqual(new Set([CompensationReason.JoinFailed]));
  });

  test("a throw on a child workflow's answer: the child's seat and room are released by the join", async ({
    app,
    mockService,
  }) => {
    const desk = mockService(TripBookingDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    await expect(execute(app, ArbiterThrowsChildWorkflowStart, GUEST)).rejects.toBeInstanceOf(
      StepError.Arbiter,
    );

    expect(released(desk)).toEqual(["room-1", "seat-1"]);
    // the join's unwind, not the execution's end: the branch carried the entries it took
    expect(undoReasons).toEqual([CompensationReason.JoinFailed, CompensationReason.JoinFailed]);
  });

  test("its model call meets a spent budget: the seat is released by the join", async ({
    app,
    mockModel,
    mockService,
  }) => {
    mockService(TestExecutionBudget).maxSpend.mockReturnValue(usd(0.5));
    // the first decision spends past the budget: the second is refused before the model is asked
    mockModel(AskingSeatArbiter).thenReturn(decideWith({ fine: 0.9 }, { cost: usd(0.9) }));
    const desk = mockService(TripBookingDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    const run = execute(app, ArbiterOutOfBudgetWorkflowStart, GUEST);

    await expect(run).rejects.toBeInstanceOf(LimitError.Budget);
    expect(released(desk)).toContain("seat-1");
    expect(released(desk)).toEqual(reservedOf(desk));
    expect(new Set(undoReasons)).toEqual(new Set([CompensationReason.JoinFailed]));
  });
});

describe("#1281 (10): a failed join's .onError undoes what an earlier child held, first", () => {
  test("a branch that failed: the child's seat and room are released before the side path", async ({
    app,
    mockService,
  }) => {
    const desk = mockService(TripBookingDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    mockService(TripDesk).charge.mockRejectedValue(new Error("the card is declined"));

    const result = await execute(app, JoinDeclinedTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripNotReservedWorkflowFinish, GUEST);
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
    expect(result).toHaveCompensated(BookSeatAction, {
      by: FreeSeatAction,
      reason: CompensationReason.StepFailed,
    });
    expect(result.compensations.map((record) => record.reason)).toEqual([
      CompensationReason.StepFailed,
      CompensationReason.StepFailed,
    ]);
  });

  test("a quorum not reached: the child's seat and room are released before the side path", async ({
    app,
    mockService,
  }) => {
    const desk = mockService(TripBookingDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    const result = await execute(app, QuorumMissedTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripNotReservedWorkflowFinish, GUEST);
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
  });

  test("a list past maxItems: the child's seat and room are released before the side path", async ({
    app,
    mockService,
  }) => {
    const desk = mockService(TripBookingDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    const result = await execute(app, TooManyCarsTripWorkflowStart, GUEST);

    expect(result).toFinishWith(TripNotReservedWorkflowFinish, GUEST);
    expect(desk.release.mock.calls.map(([id]) => id)).toEqual(["room-1", "seat-1"]);
    expect(result.compensations.map((record) => record.reason)).toEqual([
      CompensationReason.StepFailed,
      CompensationReason.StepFailed,
    ]);
  });

  test("a join that succeeds commits them: nothing is released", async ({ app, mockService }) => {
    const desk = mockService(TripBookingDesk);
    desk.reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));

    await execute(app, JoinDeclinedTripWorkflowStart, GUEST);

    expect(desk.release.mock.calls).toEqual([]);
  });
});
