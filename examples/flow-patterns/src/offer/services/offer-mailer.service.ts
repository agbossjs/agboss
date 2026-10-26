import { Injectable } from "@agboss/core";

/** Sends an offer to the candidate (a service: the I/O). */
@Injectable()
export class OfferMailer {
  send(text: string): Promise<boolean> {
    return Promise.resolve(text.length > 0);
  }
}
