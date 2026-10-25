import {
  listOf,
  Action,
  EmptyEnvironment,
  ExecutionContext,
  StepFailedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type CompensationEndEvent,
  type ExecutionErrorEvent,
  type OnCompensationEnd,
  type OnExecutionError,
  type Produced,
} from "../../../../src/index.js";
import { Injectable } from "../../../../src/components/decorators.js";
import { Application } from "../../../../src/application/application.js";
import { seconds } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { start, toAction, toFinish } from "../../../helpers/flow.js";
import {
  ChargeCardAction,
  ConfirmSeatAction,
  HoldSeatAction,
  NotReservedWorkflowFinish,
  ReleaseRoomAction,
  ReleaseSeatAction,
  ReservedDto,
  ReservedWorkflowFinish,
  ReserveRoomAction,
  ReserveSeatAction,
  RoomDto,
  SeatConfirmedDto,
  SeatConfirmedWorkflowFinish,
  SeatDto,
  UndoDesk,
  UndoDeskError,
  UndoRequestDto,
} from "./undo.workflow.js";

/**
 * #340 PR 3 — executions that end without a finish: the reservations of `undo.workflow.ts`, a
 * gate the tests hold a step at (`UnwindGate.wait`, on the step's signal), and a child workflow
 * per guest that reserves a room and waits.
 */

/** Where a test holds a step: `wait` resolves when the test lets it go. */
@Injectable()
export class UnwindGate {
  wait(_guest: string, _signal: AbortSignal): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "wait-action",
  description: "Waits at the gate",
  input: { request: UndoRequestDto },
  deps: [UnwindGate, ExecutionContext],
})
export class WaitAction {
  constructor(
    private readonly unwindGate: UnwindGate,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: { readonly request: Produced<UndoRequestDto, unknown> }): Promise<void> {
    await this.unwindGate.wait(input.request.value.guest, this.executionContext.signal);
  }
}

@WorkflowFinish({
  name: "seat-and-room-workflow-finish",
  description: "The confirmed seat and the room",
  input: { seat: SeatConfirmedDto, room: RoomDto },
  output: ReservedDto,
})
export class SeatAndRoomWorkflowFinish {
  finish(input: {
    readonly seat: Produced<SeatConfirmedDto, unknown>;
    readonly room: Produced<RoomDto, unknown>;
  }): ReservedDto {
    return { summary: `${input.seat.value.seatId} + ${input.room.value.roomId}` };
  }
}

@WorkflowStart({
  name: "unwind-workflow-start",
  description: "Seat, room, wait",
  input: UndoRequestDto,
})
export class UnwindWorkflowStart {}

/** A seat held until confirmed, a room a finish commits, a wait between them and the commit. */
@Workflow({
  name: "unwind-workflow",
  version: "1.0.0",
  flow: [
    start(UnwindWorkflowStart)
      .returns(UndoRequestDto)
      .toAction(HoldSeatAction)
      .returns(SeatDto)
      .toAction(ReserveRoomAction)
      .returns(RoomDto)
      .toAction(WaitAction)
      .toAction(ConfirmSeatAction)
      .returns(SeatConfirmedDto)
      .toFinish(SeatAndRoomWorkflowFinish),
  ],
  providers: [UndoDesk, UnwindGate],
})
export class UnwindWorkflow {}

@WorkflowStart({
  name: "unwind-committed-workflow-start",
  description: "Seat confirmed, then a room and a wait",
  input: UndoRequestDto,
})
export class UnwindCommittedWorkflowStart {}

/** The seat is committed before the wait: only the room is undone. */
@Workflow({
  name: "unwind-committed-workflow",
  version: "1.0.0",
  flow: [
    start(UnwindCommittedWorkflowStart)
      .returns(UndoRequestDto)
      .toAction(HoldSeatAction)
      .returns(SeatDto)
      .toAction(ConfirmSeatAction)
      .returns(SeatConfirmedDto)
      .toAction(ReserveRoomAction)
      .returns(RoomDto)
      .toAction(WaitAction)
      .toFinish(SeatAndRoomWorkflowFinish),
  ],
  providers: [UndoDesk, UnwindGate],
})
export class UnwindCommittedWorkflow {}

@WorkflowStart({
  name: "unwind-side-path-workflow-start",
  description: "A failed charge undone on its side path, then a wait",
  input: UndoRequestDto,
})
export class UnwindSidePathWorkflowStart {}

/** The side path undoes both, then waits: a cancel there undoes nothing again. */
@Workflow({
  name: "unwind-side-path-workflow",
  version: "1.0.0",
  flow: [
    start(UnwindSidePathWorkflowStart)
      .returns(UndoRequestDto)
      .toAction(HoldSeatAction)
      .returns(SeatDto)
      .toAction(ReserveRoomAction)
      .returns(RoomDto)
      .toAction(ChargeCardAction)
      .onError(
        UndoDeskError,
        toAction(ReleaseRoomAction)
          .toAction(ReleaseSeatAction)
          .toAction(WaitAction)
          .toFinish(NotReservedWorkflowFinish),
      )
      .toAction(ConfirmSeatAction)
      .returns(SeatConfirmedDto)
      .toFinish(SeatConfirmedWorkflowFinish),
  ],
  providers: [UndoDesk, UnwindGate],
})
export class UnwindSidePathWorkflow {}

@WorkflowStart({
  name: "unwind-room-workflow-start",
  description: "One guest",
  input: UndoRequestDto,
})
export class UnwindRoomWorkflowStart {}

@WorkflowFinish({ name: "room-reserved-workflow-finish", description: "The room", output: RoomDto })
export class RoomReservedWorkflowFinish {}

/** The child: one guest's room, then a wait. */
@Workflow({
  name: "unwind-room-workflow",
  version: "1.0.0",
  flow: [
    start(UnwindRoomWorkflowStart)
      .returns(UndoRequestDto)
      .toAction(ReserveRoomAction)
      .returns(RoomDto)
      .toAction(WaitAction)
      .toFinish(RoomReservedWorkflowFinish),
  ],
  providers: [UndoDesk, UnwindGate],
})
export class UnwindRoomWorkflow {}

@WorkflowStart({
  name: "unwind-many-workflow-start",
  description: "A room per guest",
  input: listOf(UndoRequestDto),
})
export class UnwindManyWorkflowStart {}

@WorkflowFinish({
  name: "rooms-reserved-workflow-finish",
  description: "Every room",
  input: { rooms: listOf(RoomDto) },
  output: ReservedDto,
})
export class RoomsReservedWorkflowFinish {
  finish(input: { readonly rooms: readonly Produced<RoomDto, unknown>[] }): ReservedDto {
    return {
      summary: input.rooms
        .map((room) => room.value.roomId)
        .join(", "),
    };
  }
}

/** A child per guest: a failing one aborts the others (`FailFast`), each undoes its own room. */
@Workflow({
  name: "unwind-many-workflow",
  version: "1.0.0",
  flow: [
    start(UnwindManyWorkflowStart)
      .returns(listOf(UndoRequestDto))
      .toParallelWorkflows(UnwindRoomWorkflow, { maxConcurrency: 2, maxItems: 5 })
      .join()
      .returns(listOf(RoomDto))
      .toFinish(RoomsReservedWorkflowFinish),
  ],
})
export class UnwindManyWorkflow {}

@WorkflowStart({
  name: "unwind-parent-workflow-start",
  description: "A seat, then the child's room",
  input: UndoRequestDto,
})
export class UnwindParentWorkflowStart {}

/** A seat, then one child: its failure is the side path's, a failed undo of it nobody's (S5). */
@Workflow({
  name: "unwind-parent-workflow",
  version: "1.0.0",
  flow: [
    start(UnwindParentWorkflowStart)
      .returns(UndoRequestDto)
      .toAction(ReserveSeatAction)
      .returns(SeatDto)
      .toWorkflow(UnwindRoomWorkflow)
      .onError(
        StepFailedError,
        toAction(ReleaseSeatAction)
          .toFinish(NotReservedWorkflowFinish),
      )
      .returns(RoomDto)
      .toFinish(ReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class UnwindParentWorkflow {}

/** What the tests read: every undo that ended, every execution that failed. */
export const unwindSeen: {
  readonly undos: CompensationEndEvent[];
  readonly errors: ExecutionErrorEvent[];
} = { undos: [], errors: [] };

@Injectable()
export class UnwindLog implements OnCompensationEnd, OnExecutionError {
  onCompensationEnd(event: CompensationEndEvent): void {
    unwindSeen.undos.push(event);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    unwindSeen.errors.push(event);
  }
}

@Application({
  name: "unwind-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    UnwindWorkflow,
    UnwindCommittedWorkflow,
    UnwindSidePathWorkflow,
    UnwindManyWorkflow,
    UnwindParentWorkflow,
  ],
  observers: [UnwindLog],
  budgets: TEST_BUDGETS,
  compensationTimeout: seconds(5),
})
export class UnwindApplication {}
