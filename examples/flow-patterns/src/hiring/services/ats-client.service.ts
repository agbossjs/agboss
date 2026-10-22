import { Injectable } from "agboss";

/** The ATS did not answer, or refused: an undo that meets it hands the offer to a person. */
export class AtsUnavailableError extends Error {
  override name = "AtsUnavailableError";
}

/** The ATS (a service: the I/O); every call carries the step's idempotency key. */
@Injectable()
export class AtsClientService {
  async registerOffer(candidateId: string, role: string, idempotencyKey: string): Promise<string> {
    const response: Response = await fetch("https://ats.example.com/offers", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ candidateId, role }),
    });
    if (!response.ok) throw new AtsUnavailableError(`ATS answered ${String(response.status)}`);
    const body = (await response.json()) as { readonly id: string };
    return body.id;
  }

  async withdrawOffer(offerId: string, idempotencyKey: string): Promise<void> {
    const response: Response = await fetch(`https://ats.example.com/offers/${offerId}/withdraw`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (!response.ok) throw new AtsUnavailableError(`ATS answered ${String(response.status)}`);
  }

  async confirmOffer(offerId: string, idempotencyKey: string): Promise<void> {
    const response: Response = await fetch(`https://ats.example.com/offers/${offerId}/confirm`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (!response.ok) throw new AtsUnavailableError(`ATS answered ${String(response.status)}`);
  }
}
