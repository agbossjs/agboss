import {
  Action,
  ExecutionContext,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { TripHotelDto, TripRequestDto } from "../dtos/trip.dto.js";
import { BookingDeskService } from "../services/booking-desk.service.js";
import { CancelHotelAction } from "./cancel-hotel.action.js";

/** Books the hotel; no `committedBy`: the trip's finish commits it. */
@Action({
  name: "book-hotel-action",
  description: "Books the trip's hotel",
  input: { request: TripRequestDto },
  output: TripHotelDto,
  compensateWith: CancelHotelAction,
  deps: [BookingDeskService, ExecutionContext],
})
export class BookHotelAction implements ActionHandler<BookHotelAction> {
  constructor(
    private readonly bookingDeskService: BookingDeskService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<BookHotelAction>): Promise<OutputOf<BookHotelAction>> {
    const { destination, nights } = input.request.value;
    const key: string = this.executionContext.step.idempotencyKey;
    return { bookingId: await this.bookingDeskService.bookHotel(destination, nights, key) };
  }
}
