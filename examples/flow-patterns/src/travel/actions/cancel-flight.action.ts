import { Action, ExecutionContext, type ActionHandler, type InputOf } from "@agboss/core";
import { TripFlightDto } from "../dto/trip.dto.js";
import { BookingDeskService } from "../services/booking-desk.service.js";

/** The undo of `book-flight-action`: an ordinary @Action, safe to run twice. */
@Action({
  name: "cancel-flight-action",
  description: "Cancels the booked flight",
  input: { flight: TripFlightDto },
  deps: [BookingDeskService, ExecutionContext],
})
export class CancelFlightAction implements ActionHandler<CancelFlightAction> {
  constructor(
    private readonly bookingDeskService: BookingDeskService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<CancelFlightAction>): Promise<void> {
    // run automatically on a failed join: the key is "<book-flight-action's key>:compensation"
    await this.bookingDeskService.cancelFlight(
      input.flight.value.bookingId,
      this.executionContext.step.idempotencyKey,
    );
  }
}
