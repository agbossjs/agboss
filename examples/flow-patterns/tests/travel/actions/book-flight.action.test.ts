import { beforeEach, describe, expect, it } from "vitest";
import { Injectable, OutboundCallUnreconciledError } from "@agboss/core";
import { override, testAction } from "@agboss/core/testing";
import { seconds } from "@agboss/core/units";
import { BookFlightAction } from "../../../src/travel/actions/book-flight.action.js";
import {
  BookingDeskService,
  FlightBookingState,
  type FlightLookup,
} from "../../../src/travel/services/booking-desk.service.js";
import { TripWorkflowStart } from "../../../src/travel/workflows/trip/trip.workflow-start.js";

/**
 * #505 — the flight booking is a call that leaves the system: its intent is recorded before the
 * airline is called. A second run of one runner is the same step run again, so a booking left
 * pending (its call aborted by the timeout before the airline answered, as a process killed
 * before the answer) is looked up by its key — one test per verdict — and never booked blindly.
 */

/** The airline without the network: its bookings by key, and a lever to freeze the next one. */
const airline = {
  bookings: new Map<string, string>(),
  calls: [] as string[],
  freeze: "none" as "none" | "before" | "after",
  lookup: undefined as FlightLookup | undefined,
};

/** Never answers: rejects once `signal` aborts — the request the stopped step ends. */
const abortedBy = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new Error("the airline request was aborted"));
    });
  });

@Injectable()
class FakeBookingDeskService extends BookingDeskService {
  override async bookFlight(
    destination: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    airline.calls.push(idempotencyKey);
    if (airline.freeze === "before") await abortedBy(signal);
    const bookingId = airline.bookings.get(idempotencyKey) ?? `${destination}-flight-1`;
    airline.bookings.set(idempotencyKey, bookingId);
    if (airline.freeze === "after") await abortedBy(signal);
    return bookingId;
  }

  override findFlight(idempotencyKey: string): Promise<FlightLookup> {
    const bookingId = airline.bookings.get(idempotencyKey);
    const found =
      bookingId === undefined
        ? { state: FlightBookingState.Missing }
        : { state: FlightBookingState.Booked, bookingId };
    return Promise.resolve(airline.lookup ?? found);
  }
}

const REQUEST = {
  request: { producer: TripWorkflowStart, value: { destination: "Lisbon", nights: 3 } },
};

const runner = () =>
  testAction(BookFlightAction, {
    overrides: [override(BookingDeskService, FakeBookingDeskService)],
  });

/** A runner whose first booking was left pending: frozen at the airline until its timeout. */
async function leftPending(freeze: "before" | "after"): Promise<ReturnType<typeof runner>> {
  const run = runner();
  airline.freeze = freeze;
  const first = run(REQUEST, { timeout: seconds(1) });
  first.catch(() => undefined);
  await run.clock.advance(seconds(1));
  await expect(first).rejects.toThrow();
  airline.freeze = "none";
  return run;
}

beforeEach(() => {
  airline.bookings.clear();
  airline.calls.length = 0;
  airline.freeze = "none";
  airline.lookup = undefined;
});

it("testAction: an undoable action, its service overridden", async () => {
  const { output } = await runner()(REQUEST);

  expect(output.bookingId).toContain("Lisbon");
});

describe("#505: the booking left pending, one test per verdict", () => {
  it("the airline booked it: the step goes on with its booking, nothing booked again", async () => {
    const run = await leftPending("after");

    const { output } = await run(REQUEST);

    expect(output).toEqual({ bookingId: "Lisbon-flight-1" });
    expect(airline.calls).toHaveLength(1);
  });

  it("the airline never got it: booked once more, with the same key", async () => {
    const run = await leftPending("before");

    await run(REQUEST);

    expect(airline.calls).toHaveLength(2);
    expect(new Set(airline.calls).size).toBe(1);
  });

  it("the airline cannot say yet: OutboundCallUnreconciledError, nothing booked again", async () => {
    const run = await leftPending("after");
    airline.lookup = { state: FlightBookingState.Processing };

    await expect(run(REQUEST)).rejects.toBeInstanceOf(OutboundCallUnreconciledError);
    expect(airline.calls).toHaveLength(1);
  });
});
