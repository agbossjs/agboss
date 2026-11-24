import {
  Action,
  Idempotency,
  OutboundRecovery,
  Reconciliation,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { hours, seconds } from "@agboss/core/units";
import { TripFlightDto, TripRequestDto } from "../dto/trip.dto.js";
import {
  BookingDeskService,
  FlightBookingState,
  type FlightLookup,
} from "../services/booking-desk.service.js";
import { CancelFlightAction } from "./cancel-flight.action.js";

/** What the airline's lookup means for a booking left pending (#505). */
function reconciliationOf(found: FlightLookup): Reconciliation<TripFlightDto> {
  if (found.state === FlightBookingState.Missing) return Reconciliation.notExecuted();
  if (found.state === FlightBookingState.Booked && found.bookingId !== undefined)
    return Reconciliation.completed({ bookingId: found.bookingId });
  return Reconciliation.unknown(`the airline says ${found.state}`);
}

/**
 * Books the flight — a call that leaves the system (#505): `Idempotency.sendOnce` records the intent before
 * the airline is called and settles it after, so a booking killed before the answer is looked up
 * by its key (its `recovery`), never booked twice. No `committedBy`: the trip's finish commits it.
 */
@Action({
  name: "book-flight-action",
  description: "Books the trip's flight",
  input: { request: TripRequestDto },
  output: TripFlightDto,
  compensateWith: CancelFlightAction, // a failed join cancels it automatically
  deps: [BookingDeskService, Idempotency],
})
export class BookFlightAction implements ActionHandler<BookFlightAction> {
  constructor(
    private readonly bookingDeskService: BookingDeskService,
    private readonly idempotency: Idempotency,
  ) {}

  async execute(input: InputOf<BookFlightAction>): Promise<OutputOf<BookFlightAction>> {
    const { destination } = input.request.value;
    const { result } = await this.idempotency.sendOnce({
      name: "book-flight",
      target: "airline",
      operation: "book-flight",
      request: { destination },
      timeout: seconds(30),
      ttl: hours(48),
      send: async (call) => ({
        // the call's signal: a step that stops ends its request, so its attempt's owner is gone
        bookingId: await this.bookingDeskService.bookFlight(
          destination,
          call.idempotencyKey,
          call.signal,
        ),
      }),
      // the airline's own bookings are looked up, not its key store: "missing" is true at any age
      recovery: OutboundRecovery.permanentLookup(async (lookup) =>
        reconciliationOf(await this.bookingDeskService.findFlight(lookup.idempotencyKey)),
      ),
    });
    return { bookingId: result.bookingId };
  }
}
