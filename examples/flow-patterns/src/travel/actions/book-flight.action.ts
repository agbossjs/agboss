import {
  Action,
  ExecutionContext,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { TripFlightDto, TripRequestDto } from "../dto/trip.dto.js";
import { BookingDeskService } from "../services/booking-desk.service.js";
import { CancelFlightAction } from "./cancel-flight.action.js";

/** Books the flight; no `committedBy`: the trip's finish commits it. */
@Action({
  name: "book-flight-action",
  description: "Books the trip's flight",
  input: { request: TripRequestDto },
  output: TripFlightDto,
  compensateWith: CancelFlightAction, // a failed join cancels it automatically
  deps: [BookingDeskService, ExecutionContext],
})
export class BookFlightAction implements ActionHandler<BookFlightAction> {
  constructor(
    private readonly bookingDeskService: BookingDeskService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<BookFlightAction>): Promise<OutputOf<BookFlightAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return {
      bookingId: await this.bookingDeskService.bookFlight(input.request.value.destination, key),
    };
  }
}
