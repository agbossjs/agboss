import { Injectable } from "agboss";

/** A booking was refused, or its service did not answer. */
export class BookingFailedError extends Error {
  override name = "BookingFailedError";
}

/** The airline and the hotel (a service: the I/O); every call carries the step's idempotency key. */
@Injectable()
export class BookingDeskService {
  bookFlight(destination: string, idempotencyKey: string): Promise<string> {
    return this.#post("https://travel.example.com/flights", idempotencyKey, { destination });
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
