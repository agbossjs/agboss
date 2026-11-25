import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import {
  BookTripAction,
  CancelBookingAction,
  ChargeAction,
  ConfirmTripAction,
  NotifyAgencyAction,
  RefundAction,
  TripBookedWorkflowFinish,
  TripLetterAgent,
  TripNotBookedWorkflowFinish,
  TripWorkflowStart,
} from "../fixtures/compensation-parts.js";
import { onStart, toAction, toFinish } from "../fixtures/paths.js";
import type { PathBuilder } from "../../../src/flow/path-builder.js";
import { Ttl } from "../../../src/index.js";

/**
 * #339 AC2 — a side path after an undoable action reaches a finish only through its undo action,
 * newest first (`[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`); with
 * `committedBy`, every path from it runs the committer or the undo (`[flow.uncommitted-action]`);
 * a committer no path reaches is a warning (`[flow.committer-unreachable]`).
 */

type Flow = WorkflowOptions["flow"];

const CODES = new Set([
  "flow.uncompensated-action",
  "flow.uncommitted-action",
  "flow.compensation-out-of-order",
  "flow.committer-unreachable",
]);

let count = 0;
function checked(flow: Flow) {
  count += 1;
  @Workflow({
    name: `trip-case-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow,
  })
  class TripCaseWorkflow {}
  const strip = ({ code, message }: { code: string; message: string }) => ({
    code,
    message: message.replace(/^trip-case-\d+-workflow: /, ""),
  });
  const { errors, warnings } = checkWorkflow(TripCaseWorkflow);
  return {
    errors: errors.filter((found) => CODES.has(found.code)).map(strip),
    warnings: warnings.filter((found) => CODES.has(found.code)).map(strip),
  };
}

/** Book, charge, then a letter that may fail: `side` takes its failure; the confirmation commits. */
const booked = (side: PathBuilder): Flow => [
  onStart(TripWorkflowStart)
    .toAction(BookTripAction)
    .toAction(ChargeAction)
    .toAgent(TripLetterAgent)
    .onError(StepError, side)
    .toAction(ConfirmTripAction)
    .toFinish(TripBookedWorkflowFinish),
];

describe("#339 AC2: a side path undoes what is open, newest first", () => {
  it("a side path that undoes both, newest first — its undo's own failure handed to a person", () => {
    const side = toAction(RefundAction)
      .toAction(CancelBookingAction)
      .onError(Error, toAction(NotifyAgencyAction).toFinish(TripNotBookedWorkflowFinish))
      .toFinish(TripNotBookedWorkflowFinish);

    const found = checked(booked(side));

    expect(found.errors).toEqual([]);
    expect(found.warnings).toEqual([]);
  });

  it("a side path straight to a finish names every missing undo, newest first", () => {
    expect(checked(booked(toFinish(TripNotBookedWorkflowFinish))).errors).toEqual([
      {
        code: "flow.uncompensated-action",
        message:
          "the .onError(StepError, …) side path after trip-letter-agent reaches trip-not-booked-workflow-finish without refund-action (compensates charge-action) and cancel-booking-action (compensates book-trip-action); add them to the side path, newest first, or commit the actions before it",
      },
    ]);
  });

  it("one missing undo: the message names it alone", () => {
    const side = toAction(RefundAction).toFinish(TripNotBookedWorkflowFinish);

    expect(checked(booked(side)).errors).toEqual([
      {
        code: "flow.uncompensated-action",
        message:
          "the .onError(StepError, …) side path after trip-letter-agent reaches trip-not-booked-workflow-finish without cancel-booking-action (compensates book-trip-action); add it to the side path, or commit the action before it",
      },
    ]);
  });

  it("undo actions in the wrong order", () => {
    const side = toAction(CancelBookingAction)
      .toAction(RefundAction)
      .toFinish(TripNotBookedWorkflowFinish);

    expect(checked(booked(side)).errors).toEqual([
      {
        code: "flow.compensation-out-of-order",
        message:
          "cancel-booking-action (compensates book-trip-action) runs before refund-action (compensates charge-action) on the path trip-workflow-start → book-trip-action → charge-action → trip-letter-agent → cancel-booking-action → refund-action — undo newest first: refund-action, then cancel-booking-action",
      },
    ]);
  });

  it("after its committing action a side path owes nothing for the committed action", () => {
    const flow: Flow = [
      onStart(TripWorkflowStart)
        .toAction(BookTripAction)
        .toAction(ConfirmTripAction)
        .toAgent(TripLetterAgent)
        .onError(StepError, toFinish(TripNotBookedWorkflowFinish))
        .toFinish(TripBookedWorkflowFinish),
    ];

    expect(checked(flow).errors).toEqual([]);
  });

  it("the undoable action's own failure owes only the actions before it", () => {
    const flow: Flow = [
      onStart(TripWorkflowStart)
        .toAction(BookTripAction)
        .toAction(ChargeAction)
        .onError(StepError, toAction(CancelBookingAction).toFinish(TripNotBookedWorkflowFinish))
        .toAction(ConfirmTripAction)
        .toFinish(TripBookedWorkflowFinish),
    ];

    expect(checked(flow).errors).toEqual([]);
  });
});

describe("#339 AC2: a failed join's side path owes what was open before the launch", () => {
  const joined = (side: PathBuilder): Flow => [
    onStart(TripWorkflowStart)
      .toAction(BookTripAction)
      .inParallel([toAction(ChargeAction), toAction(NotifyAgencyAction)])
      .join()
      .onError(StepError, side)
      .toAction(ConfirmTripAction)
      .toFinish(TripBookedWorkflowFinish),
  ];

  it("the booking before the launch must be undone; the finished charge is undone automatically", () => {
    expect(checked(joined(toFinish(TripNotBookedWorkflowFinish))).errors).toEqual([
      {
        code: "flow.uncompensated-action",
        message:
          "the .onError(StepError, …) side path after the join of book-trip-action → inParallel(charge-action, notify-agency-action) reaches trip-not-booked-workflow-finish without cancel-booking-action (compensates book-trip-action); add it to the side path, or commit the action before it",
      },
    ]);
    const undone = toAction(CancelBookingAction).toFinish(TripNotBookedWorkflowFinish);
    expect(checked(joined(undone)).errors).toEqual([]);
  });
});

describe("#1284: a group of .joinQuorumGroups opens only its own targets' undoable actions", () => {
  const grouped = (): Flow => [
    onStart(TripWorkflowStart)
      .inParallel([toAction(BookTripAction), toAction(NotifyAgencyAction)])
      .joinQuorumGroups()
      .onGroup([BookTripAction], toFinish(TripBookedWorkflowFinish))
      .onGroup([NotifyAgencyAction], toFinish(TripNotBookedWorkflowFinish)),
  ];

  it("the booking is owed (uncommitted) on the path of the group that counted it, not on the other", () => {
    const { errors } = checked(grouped());

    expect(errors.map(({ code }) => code)).toEqual(["flow.uncommitted-action"]);
    expect(errors[0]?.message).toContain("trip-booked-workflow-finish");
    expect(errors[0]?.message).not.toContain("trip-not-booked-workflow-finish");
  });
});

describe("#339: committedBy — the committer or the undo on every path", () => {
  it("a path to a finish with neither is [flow.uncommitted-action]", () => {
    const flow: Flow = [
      onStart(TripWorkflowStart)
        .toAction(BookTripAction)
        .toAction(NotifyAgencyAction)
        .toFinish(TripNotBookedWorkflowFinish),
    ];

    expect(checked(flow).errors).toEqual([
      {
        code: "flow.uncommitted-action",
        message:
          "book-trip-action is committed by confirm-trip-action, but the path trip-workflow-start → book-trip-action → notify-agency-action → trip-not-booked-workflow-finish reaches trip-not-booked-workflow-finish with neither confirm-trip-action nor cancel-booking-action — add one of them to that path, or leave committedBy out (a finish then commits it)",
      },
    ]);
  });

  it("a committer no path reaches is a warning", () => {
    const flow: Flow = [
      onStart(TripWorkflowStart)
        .toAction(BookTripAction)
        .toAction(CancelBookingAction)
        .toFinish(TripNotBookedWorkflowFinish),
    ];

    const found = checked(flow);

    expect(found.errors).toEqual([]);
    expect(found.warnings).toEqual([
      {
        code: "flow.committer-unreachable",
        message:
          "book-trip-action is committed by confirm-trip-action, which no path from book-trip-action reaches — every path after it must run cancel-booking-action; add confirm-trip-action after it, or leave committedBy out",
      },
    ]);
  });
});
