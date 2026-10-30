import { Injectable } from "@agboss/core";

/** A booking was refused, or its service did not answer. */
export class BookingFailedError extends Error {
  override name = "BookingFailedError";
}

/** Where a flight booking stands at the airline, found by the key it was sent with. */
export enum FlightBookingState {
  Booked = "booked",
  /** The airline never got it. */
  Missing = "missing",
  /** The airline got it and is still working on it. */
  Processing = "processing",
}

/** What the airline says of a booking looked up by its idempotency key. */
export interface FlightLookup {
  readonly state: FlightBookingState;
  readonly bookingId?: string;
}

/** The airline and the hotel (a service: the I/O); every call carries the step's idempotency key. */
@Injectable()
export class BookingDeskService {
  bookFlight(destination: string, idempotencyKey: string): Promise<string> {
    return this.#post("https://travel.example.com/flights", idempotencyKey, { destination });
  }

  /** The booking made with `idempotencyKey`, as the airline knows it (its lookup by key). */
  async findFlight(idempotencyKey: string): Promise<FlightLookup> {
    const url = `https://travel.example.com/flights?idempotencyKey=${encodeURIComponent(idempotencyKey)}`;
    const response: Response = await fetch(url);
    if (response.status === 404) return { state: FlightBookingState.Missing };
    if (!response.ok) throw new BookingFailedError(`${url} answered ${String(response.status)}`);
    return (await response.json()) as FlightLookup;
  }

  async cancelFlight(bookingId: string, idempotencyKey: string): Promise<void> {
    await this.#post(`https://travel.example.com/flights/${bookingId}/cancel`, idempotencyKey, {});
  }

  bookHotel(destination: string, nights: number, idempotencyKey: string): Promise<string> {
    const body = { destination, nights };
    return this.#post("https://travel.example.com/hotels", idempotencyKey, body);
  }

  async cancelHotel(bookingId: string, idempotencyKey: string): Promise<void> {
    await this.#post(`https://travel.example.com/hotels/${bookingId}/cancel`, idempotencyKey, {});
  }

  async #post(url: string, idempotencyKey: string, body: object): Promise<string> {
    const response: Response = await fetch(url, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new BookingFailedError(`${url} answered ${String(response.status)}`);
    const answer = (await response.json()) as { readonly id: string };
    return answer.id;
  }
}
