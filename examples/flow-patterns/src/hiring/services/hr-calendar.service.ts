import { Injectable } from "agboss";

/** The HR calendar did not answer, or refused. */
export class CalendarUnavailableError extends Error {
  override name = "CalendarUnavailableError";
}

/** The HR calendar (a service: the I/O); every call carries the step's idempotency key. */
@Injectable()
export class HrCalendarService {
  async bookSlot(offerId: string, idempotencyKey: string): Promise<string> {
    const response: Response = await fetch("https://hr.example.com/onboarding-slots", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ offerId }),
    });
    if (!response.ok) throw new CalendarUnavailableError(`HR answered ${String(response.status)}`);
    const body = (await response.json()) as { readonly id: string };
    return body.id;
  }

  async releaseSlot(slotId: string, idempotencyKey: string): Promise<void> {
    const response: Response = await fetch(`https://hr.example.com/onboarding-slots/${slotId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (!response.ok) throw new CalendarUnavailableError(`HR answered ${String(response.status)}`);
  }
}
