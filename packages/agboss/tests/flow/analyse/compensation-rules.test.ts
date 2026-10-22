import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  BookingDto,
  ConfirmTripAction,
  NotifyAgencyAction,
  RefundAction,
  TripNotBookedWorkflowFinish,
  TripRequestDto,
  TripWorkflowStart,
} from "../fixtures/compensation-parts.js";
import { start } from "../fixtures/paths.js";

/**
 * #339 AC1 — `@Action({ compensateWith, committedBy })` name `@Action` classes; an action does not
 * undo itself, an undo action is not undone, the undo reads only what the path holds right after
 * the action, and `committedBy` needs `compensateWith` (S3) — every violation at once.
 */

/** Has `execute`, but no `@Action`: not a component. */
class UndecoratedUndo {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

const READS_REQUEST = { input: { request: TripRequestDto } } as const;

@Action({
  name: "wrong-undo-action",
  description: "x",
  ...READS_REQUEST,
  compensateWith: UndecoratedUndo,
})
class WrongUndoAction extends UndecoratedUndo {}

@Action({
  name: "wrong-commit-action",
  description: "x",
  ...READS_REQUEST,
  compensateWith: NotifyAgencyAction,
  committedBy: UndecoratedUndo,
})
class WrongCommitAction extends UndecoratedUndo {}

class SelfUndoAction extends UndecoratedUndo {}
Action({
  name: "self-undo-action",
  description: "x",
  ...READS_REQUEST,
  compensateWith: SelfUndoAction,
})(SelfUndoAction);

@Action({
  name: "chained-undo-action",
  description: "x",
  ...READS_REQUEST,
  compensateWith: NotifyAgencyAction,
})
class ChainedUndoAction extends UndecoratedUndo {}

@Action({
  name: "main-chain-action",
  description: "x",
  ...READS_REQUEST,
  compensateWith: ChainedUndoAction,
})
class MainChainAction extends UndecoratedUndo {}

@Action({
  name: "bad-input-action",
  description: "x",
  ...READS_REQUEST,
  output: BookingDto,
  compensateWith: RefundAction, // reads a PaymentDto: no path brings one
})
class BadInputAction extends UndecoratedUndo {}

@Action({
  name: "commit-only-action",
  description: "x",
  ...READS_REQUEST,
  committedBy: ConfirmTripAction, // nothing undoes it: committedBy has no effect
})
class CommitOnlyAction extends UndecoratedUndo {}

@Workflow({
  name: "broken-undo-workflow",
  version: "1.0.0",
  flow: [
    start(TripWorkflowStart)
      .returns(TripRequestDto)
      .toAction(WrongUndoAction)
      .toAction(WrongCommitAction)
      .toAction(SelfUndoAction)
      .toAction(MainChainAction)
      .toAction(CommitOnlyAction)
      .toAction(BadInputAction)
      .returns(BookingDto)
      .toFinish(TripNotBookedWorkflowFinish),
  ],
})
class BrokenUndoWorkflow {}

describe("#339 AC1: compensateWith and committedBy name well-formed @Action classes", () => {
  it("reports every action.* violation at once", () => {
    const found = checkWorkflow(BrokenUndoWorkflow)
      .errors.filter((violation) => violation.code.startsWith("action."))
      .map(({ code, message }) => ({
        code,
        message: message.replace("broken-undo-workflow: ", ""),
      }));

    expect(found).toEqual([
      {
        code: "action.committer-not-an-action",
        message:
          "wrong-commit-action: committedBy UndecoratedUndo is not an @Action — name the @Action after which nothing undoes it, or leave committedBy out (a finish commits it)",
      },
      {
        code: "action.committer-without-compensator",
        message:
          "commit-only-action: committedBy confirm-trip-action has no effect without compensateWith — nothing undoes commit-only-action, so nothing commits it; add compensateWith (the @Action that undoes it), or remove committedBy",
      },
      {
        code: "action.compensator-compensates",
        message:
          "chained-undo-action undoes main-chain-action and declares compensateWith notify-agency-action itself — an undo action is not undone (no chains); remove compensateWith from chained-undo-action",
      },
      {
        code: "action.compensator-not-an-action",
        message:
          "wrong-undo-action: compensateWith UndecoratedUndo is not an @Action — an undo is code, never a model call: name an @Action class that undoes it",
      },
      {
        code: "action.invalid-compensator-input",
        message:
          "bad-input-action: compensateWith refund-action reads refund-action.payment (PaymentDto), which is not on the path right after bad-input-action (trip-workflow-start → wrong-undo-action → wrong-commit-action → self-undo-action → main-chain-action → commit-only-action → bad-input-action) — an undo reads only what reached the action or what it returned",
      },
      {
        code: "action.self-compensation",
        message:
          "self-undo-action: compensateWith names the action itself — name the @Action that undoes it",
      },
    ]);
  });
});
