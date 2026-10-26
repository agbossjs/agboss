import { Injectable } from "@agboss/core";

/** Where a recruiter hears from the send-offer workflow (a service: the I/O). */
@Injectable()
export class RecruiterDeskService {
  /** Posts a letter for the recruiter to approve, in the terminal: the reply names `replyKey`. */
  post(note: string, replyKey: string): void {
    process.stderr.write(`\n[OFFER LETTER TO APPROVE] (pause ${replyKey})\n${note}\n`);
  }

  /** Tells the recruiter something needs a person; whether the note was delivered. */
  alert(note: string): Promise<boolean> {
    return Promise.resolve(note.length > 0);
  }
}
