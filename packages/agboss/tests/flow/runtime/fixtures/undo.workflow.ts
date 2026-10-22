import { Text } from "../../../../src/dto/index.js";
import {
  Action,
  EmptyEnvironment,
  ExecutionContext,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type CompensationEndEvent,
  type CompensationStartEvent,
  type OnCompensationEnd,
  type OnCompensationStart,
  type Produced,
} from "../../../../src/index.js";
import { Injectable } from "../../../../src/components/decorators.js";
import { Application } from "../../../../src/application/application.js";
import { seconds, usd } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { start, toAction, toFinish } from "../../../helpers/flow.js";

/**
 * #340 PR 2 — undoable reservations: a seat (undone by its release, committed by its
 * confirmation), a room (undone by its release, committed by a finish) and a card charge (no
 * undo) that may fail. The desk is the I/O the tests mock; each undo passes its key and its
 * clean-up signal to it, and records what its `ExecutionContext` said.
 */

export class UndoRequestDto {
  @Text({ prompt: "who reserves" })
  guest!: string;
}

export class SeatDto {
  @Text({ prompt: "the seat's id" })
  seatId!: string;
}

export class RoomDto {
  @Text({ prompt: "the room's id" })
  roomId!: string;
}

export class SeatConfirmedDto {
  @Text({ prompt: "the confirmed seat" })
  seatId!: string;
}

export class ReservedDto {
  @Text({ prompt: "what was reserved" })
  summary!: string;
}

/** The desk refused, or did not answer. */
export class UndoDeskError extends Error {
  override name = "UndoDeskError";
}

/** What an undo's step said while it ran. */
export interface UndoStepSeen {
  readonly key: string;
  readonly compensates: string | undefined;
  readonly isAborted: boolean;
}

/** The reservation desk: every call the tests mock. */
@Injectable()
export class UndoDesk {
  reserve(kind: string): Promise<string> {
    return Promise.resolve(`${kind}-1`);
  }

  release(_id: string, _key: string, _signal: AbortSignal): Promise<void> {
    return Promise.resolve();
  }

  charge(): Promise<void> {
    return Promise.resolve();
  }

  seen(_step: UndoStepSeen): void {
    // the tests read what each undo's step said
  }
}

/** An undo's body: what its step says, then the release on its clean-up signal. */
async function released(
  desk: UndoDesk,
  executionContext: ExecutionContext,
  id: string,
): Promise<void> {
  const { step, signal } = executionContext;
  desk.seen({
    key: step.idempotencyKey,
    compensates: step.compensates?.idempotencyKey,
    isAborted: signal.aborted,
  });
  await desk.release(id, step.idempotencyKey, signal);
}

@Action({
  name: "release-seat-action",
  description: "Releases the seat",
  input: { seat: SeatDto },
  deps: [UndoDesk, ExecutionContext, SpendRecorder],
})
export class ReleaseSeatAction {
  constructor(
    private readonly undoDesk: UndoDesk,
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  async execute(input: { readonly seat: Produced<SeatDto, unknown> }): Promise<void> {
    this.spendRecorder.record({ service: "seat-desk", cost: usd(0.001) });
    await released(this.undoDesk, this.executionContext, input.seat.value.seatId);
  }
}

@Action({
  name: "release-room-action",
  description: "Releases the room",
  input: { room: RoomDto },
  deps: [UndoDesk, ExecutionContext],
})
export class ReleaseRoomAction {
  constructor(
    private readonly undoDesk: UndoDesk,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: { readonly room: Produced<RoomDto, unknown> }): Promise<void> {
    await released(this.undoDesk, this.executionContext, input.room.value.roomId);
  }
}

@Action({
  name: "confirm-seat-action",
  description: "Confirms the seat",
  input: { seat: SeatDto },
  output: SeatConfirmedDto,
})
export class ConfirmSeatAction {
  execute(input: { readonly seat: Produced<SeatDto, unknown> }): Promise<SeatConfirmedDto> {
    return Promise.resolve({ seatId: input.seat.value.seatId });
  }
}

@Action({
  name: "reserve-seat-action",
  description: "Reserves a seat; a finish commits it",
  input: { request: UndoRequestDto },
  output: SeatDto,
  compensateWith: ReleaseSeatAction,
  deps: [UndoDesk],
})
export class ReserveSeatAction {
  constructor(private readonly undoDesk: UndoDesk) {}

  async execute(): Promise<SeatDto> {
    return { seatId: await this.undoDesk.reserve("seat") };
  }
}

@Action({
  name: "hold-seat-action",
  description: "Holds a seat until it is confirmed",
  input: { request: UndoRequestDto },
  output: SeatDto,
  compensateWith: ReleaseSeatAction,
  committedBy: ConfirmSeatAction,
  deps: [UndoDesk],
})
export class HoldSeatAction {
  constructor(private readonly undoDesk: UndoDesk) {}

  async execute(): Promise<SeatDto> {
    return { seatId: await this.undoDesk.reserve("seat") };
  }
}

@Action({
  name: "notify-desk-action",
  description: "Tells a person what could not be undone",
  input: { request: UndoRequestDto },
})
export class NotifyDeskAction {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "reserve-room-action",
  description: "Reserves a room",
  input: { request: UndoRequestDto },
  output: RoomDto,
  compensateWith: ReleaseRoomAction,
  deps: [UndoDesk],
})
export class ReserveRoomAction {
  constructor(private readonly undoDesk: UndoDesk) {}

  async execute(): Promise<RoomDto> {
    return { roomId: await this.undoDesk.reserve("room") };
  }
}

@Action({
  name: "charge-card-action",
  description: "Charges the card",
  input: { request: UndoRequestDto },
  deps: [UndoDesk],
})
export class ChargeCardAction {
  constructor(private readonly undoDesk: UndoDesk) {}

  async execute(): Promise<void> {
    await this.undoDesk.charge();
  }
}

@WorkflowStart({ name: "undo-workflow-start", description: "A reservation", input: UndoRequestDto })
export class UndoWorkflowStart {}

@WorkflowStart({
  name: "undo-unhandled-workflow-start",
  description: "A reservation, no side path",
  input: UndoRequestDto,
})
export class UndoUnhandledWorkflowStart {}

@WorkflowStart({ name: "undo-path-workflow-start", description: "One by one", input: UndoRequestDto })
export class UndoPathWorkflowStart {}

@WorkflowFinish({
  name: "reserved-workflow-finish",
  description: "Reserved",
  input: { seat: SeatDto, room: RoomDto },
  output: ReservedDto,
})
export class ReservedWorkflowFinish {
  finish(input: {
    readonly seat: Produced<SeatDto, unknown>;
    readonly room: Produced<RoomDto, unknown>;
  }): ReservedDto {
    return { summary: `${input.seat.value.seatId} + ${input.room.value.roomId}` };
  }
}

@WorkflowFinish({
  name: "not-reserved-workflow-finish",
  description: "Nothing reserved",
  output: UndoRequestDto,
})
export class NotReservedWorkflowFinish {}

@WorkflowFinish({
  name: "seat-confirmed-workflow-finish",
  description: "The seat, confirmed",
  output: SeatConfirmedDto,
})
export class SeatConfirmedWorkflowFinish {}

/** A failed join with a side path: the finished reservations are undone before it runs. */
@Workflow({
  name: "undo-workflow",
  version: "1.0.0",
  flow: [
    start(UndoWorkflowStart)
      .returns(UndoRequestDto)
      .toParallelActions(ReserveSeatAction, ReserveRoomAction, ChargeCardAction)
      .join()
      .onJoinError(UndoDeskError, toFinish(NotReservedWorkflowFinish))
      .returns(SeatDto)
      .returns(RoomDto)
      .toFinish(ReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class UndoWorkflow {}

/** A failed join without a side path: undone, then the execution fails with the branch's error. */
@Workflow({
  name: "undo-unhandled-workflow",
  version: "1.0.0",
  flow: [
    start(UndoUnhandledWorkflowStart)
      .returns(UndoRequestDto)
      .toParallelActions(ReserveSeatAction, ReserveRoomAction, ChargeCardAction)
      .join()
      .returns(SeatDto)
      .returns(RoomDto)
      .toFinish(ReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class UndoUnhandledWorkflow {}

/**
 * One by one: the side path of a failed charge undoes the room, then the seat — the seat's own
 * failure handed to a person; otherwise the confirmation commits the seat, the finish the room.
 */
@Workflow({
  name: "undo-path-workflow",
  version: "1.0.0",
  flow: [
    start(UndoPathWorkflowStart)
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
          .onError(
            UndoDeskError,
            toAction(NotifyDeskAction)
              .toFinish(NotReservedWorkflowFinish),
          )
          .toFinish(NotReservedWorkflowFinish),
      )
      .toAction(ConfirmSeatAction)
      .returns(SeatConfirmedDto)
      .toFinish(SeatConfirmedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class UndoPathWorkflow {}

/** Every compensation event, in order. */
export const undoEvents: (CompensationStartEvent | CompensationEndEvent)[] = [];

@Injectable()
export class UndoLog implements OnCompensationStart, OnCompensationEnd {
  onCompensationStart(event: CompensationStartEvent): void {
    undoEvents.push(event);
  }

  onCompensationEnd(event: CompensationEndEvent): void {
    undoEvents.push(event);
  }
}

@Application({
  name: "undo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UndoWorkflow, UndoUnhandledWorkflow, UndoPathWorkflow],
  observers: [UndoLog],
  budgets: TEST_BUDGETS,
})
export class UndoApplication {}

/** The same workflows with a short undo bound (`compensationTimeout`). */
@Application({
  name: "undo-quick-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UndoWorkflow],
  budgets: TEST_BUDGETS,
  compensationTimeout: seconds(2),
})
export class UndoQuickApplication {}
