import { Injectable } from "@agboss/core";

/** Where the committee's parties hear from the workflow (a service: the I/O). */
@Injectable()
export class CommitteeDeskService {
  /** Posts the contract for a party to sign off, in the terminal: the reply names `replyKey`. */
  post(party: string, title: string, replyKey: string): void {
    process.stderr.write(`\n[CONTRACT TO SIGN OFF: ${party}] (pause ${replyKey})\n${title}\n`);
  }
}
