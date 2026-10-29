import { Action, ExecutionContext, type ActionHandler, type InputOf } from "@agboss/core";
import { TripHotelDto } from "../dto/trip.dto.js";
import { BookingDeskService } from "../services/booking-desk.service.js";

/** The undo of `book-hotel-action`: an ordinary @Action, safe to run twice. */
@Action({
  name: "cancel-hotel-action",
  description: "Cancels the booked hotel",
  input: { hotel: TripHotelDto },
  deps: [BookingDeskService, ExecutionContext],
})
export class CancelHotelAction implements ActionHandler<CancelHotelAction> {
  constructor(
    private readonly bookingDeskService: BookingDeskService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<CancelHotelAction>): Promise<void> {
    await this.bookingDeskService.cancelHotel(
      input.hotel.value.bookingId,
      this.executionContext.step.idempotencyKey,
    );
  }
}
