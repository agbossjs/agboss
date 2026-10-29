import { expect, it } from "vitest";
import { Injectable } from "@agboss/core";
import { override, testAction } from "@agboss/core/testing";
import { BookFlightAction } from "../../../src/travel/actions/book-flight.action.js";
import { BookingDeskService } from "../../../src/travel/services/booking-desk.service.js";
import { TripWorkflowStart } from "../../../src/travel/workflows/trip/trip.workflow-start.js";

/** The airline without the network: an `override` replaces the service in the runner's container. */
@Injectable()
class FakeBookingDeskService extends BookingDeskService {
  override bookFlight(destination: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${destination}:${idempotencyKey}`);
  }
}

it("testAction: an undoable action, its service overridden", async () => {
  const runAction = testAction(BookFlightAction, {
    overrides: [override(BookingDeskService, FakeBookingDeskService)],
  });

  const { output } = await runAction({
    request: { producer: TripWorkflowStart, value: { destination: "Lisbon", nights: 3 } },
  });

  expect(output.bookingId).toContain("Lisbon");
});
