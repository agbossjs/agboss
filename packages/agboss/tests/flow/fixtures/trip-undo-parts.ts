import { Text } from "../../../src/dto/index.js";
import { Action, WorkflowFinish, type Tracked } from "../../../src/index.js";
import { Injectable } from "../../../src/components/decorators.js";

/**
 * #1281b — the undoable reservations the quorum and child-undo fixtures share: a seat and a room,
 * each undone by its release, committed by no action (a finish commits them). No workflow here: the
 * fixtures that use them re-export them, so the generated types name them from a listed fixture.
 */

export class TripRequestDto {
  @Text({ prompt: "who travels" })
  guest!: string;
}

export class TripSeatDto {
  @Text({ prompt: "the seat's id" })
  seatId!: string;
}

export class TripRoomDto {
  @Text({ prompt: "the room's id" })
  roomId!: string;
}

export class TripSummaryDto {
  @Text({ prompt: "what was reserved" })
  summary!: string;
}

/** The desk the tests mock: what each reservation and each release got. */
@Injectable()
export class TripBookingDesk {
  reserve(kind: string): Promise<string> {
    return Promise.resolve(`${kind}-1`);
  }

  release(_id: string): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "free-seat-action",
  description: "Releases the seat",
  input: { seat: TripSeatDto },
  deps: [TripBookingDesk],
})
export class FreeSeatAction {
  constructor(private readonly tripBookingDesk: TripBookingDesk) {}

  async execute(input: { readonly seat: Tracked<TripSeatDto> }): Promise<void> {
    await this.tripBookingDesk.release(input.seat.seatId);
  }
}

@Action({
  name: "free-room-action",
  description: "Releases the room",
  input: { room: TripRoomDto },
  deps: [TripBookingDesk],
})
export class FreeRoomAction {
  constructor(private readonly tripBookingDesk: TripBookingDesk) {}

  async execute(input: { readonly room: Tracked<TripRoomDto> }): Promise<void> {
    await this.tripBookingDesk.release(input.room.roomId);
  }
}

@Action({
  name: "book-seat-action",
  description: "Reserves a seat; a finish commits it",
  input: { request: TripRequestDto },
  output: TripSeatDto,
  compensateWith: FreeSeatAction,
  deps: [TripBookingDesk],
})
export class BookSeatAction {
  constructor(private readonly tripBookingDesk: TripBookingDesk) {}

  async execute(): Promise<TripSeatDto> {
    return { seatId: await this.tripBookingDesk.reserve("seat") };
  }
}

@Action({
  name: "book-room-action",
  description: "Reserves a room; a finish commits it",
  input: { request: TripRequestDto },
  output: TripRoomDto,
  compensateWith: FreeRoomAction,
  deps: [TripBookingDesk],
})
export class BookRoomAction {
  constructor(private readonly tripBookingDesk: TripBookingDesk) {}

  async execute(): Promise<TripRoomDto> {
    return { roomId: await this.tripBookingDesk.reserve("room") };
  }
}

@WorkflowFinish({
  name: "trip-reviewed-workflow-finish",
  description: "Done",
  output: TripSummaryDto,
})
export class TripReviewedWorkflowFinish {}

@WorkflowFinish({
  name: "trip-not-reserved-workflow-finish",
  description: "Nothing counted",
  output: TripRequestDto,
})
export class TripNotReservedWorkflowFinish {}
