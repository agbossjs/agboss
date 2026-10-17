import { Injectable } from "agboss";

/** Where the recruiter hears about offers that could not be made (a service: the I/O). */
@Injectable()
export class RecruiterInbox {
  /** Whether the note was delivered. */
  notify(note: string): Promise<boolean> {
    return Promise.resolve(note.length > 0);
  }
}
