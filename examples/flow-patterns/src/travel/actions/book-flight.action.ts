import {
  Action,
  ExecutionContext,
  OutboundCallReconciliation,
  OutboundCalls,
  fencedEffectKeyOf,
  type ActionHandler,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import { TripFlightDto, TripRequestDto } from "../dto/trip.dto.js";
import {
  BookingDeskService,
  FlightBookingState,
  type FlightLookup,
} from "../services/booking-desk.service.js";
import { CancelFlightAction } from "./cancel-flight.action.js";

/** What the airline's lookup means for a booking left pending (#505). */
function reconciliationOf(found: FlightLookup): OutboundCallReconciliation<TripFlightDto> {
  if (found.state === FlightBookingState.Missing) return OutboundCallReconciliation.notSent();
  if (found.state === FlightBookingState.Booked && found.bookingId !== undefined)
    return OutboundCallReconciliation.completed({ bookingId: found.bookingId });
  return OutboundCallReconciliation.unknown({ reason: `the airline says ${found.state}` });
}

/**
 * Books the flight — a call that leaves the system (#505): `OutboundCalls` records the intent before
 * the airline is called and settles it after, so a booking killed before the answer is looked up
 * by its key (`reconcile`), never booked twice. No `committedBy`: the trip's finish commits it.
 */
@Action({
  name: "book-flight-action",
  description: "Books the trip's flight",
  input: { request: TripRequestDto },
  output: TripFlightDto,
  compensateWith: CancelFlightAction, // a failed join cancels it automatically
  deps: [BookingDeskService, ExecutionContext, OutboundCalls],
})
export class BookFlightAction implements ActionHandler<BookFlightAction> {
  constructor(
    private readonly bookingDeskService: BookingDeskService,
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
  ) {}

  async execute(input: InputOf<BookFlightAction>): Promise<OutputOf<BookFlightAction>> {
    const { destination } = input.request.value;
    const key = fencedEffectKeyOf(this.executionContext, "book-flight");
    const { result } = await this.outboundCalls.send(key, {
      target: "airline",
      operation: "book-flight",
      request: { destination },
      send: async (call) => ({
        bookingId: await this.bookingDeskService.bookFlight(destination, call.idempotencyKey),
      }),
      reconcile: async (lookup) =>
        reconciliationOf(await this.bookingDeskService.findFlight(lookup.idempotencyKey)),
    });
    return { bookingId: result.bookingId };
  }
}
