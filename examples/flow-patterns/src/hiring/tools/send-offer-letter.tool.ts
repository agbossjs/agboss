import { ExecutionContext, Tool } from "@agboss/core";
import { RecruiterToolApproval } from "../channels/recruiter-approval.channel.js";
import { LetterDelivered, LetterDelivery } from "../dto/send-offer-letter.dto.js";

/** Sends the letter — only once the recruiter approves it; its id is the call's idempotency key. */
@Tool({
  name: "send-offer-letter-tool",
  description: "Sends the offer letter once the recruiter approves it",
  input: LetterDelivery,
  output: LetterDelivered,
  approval: RecruiterToolApproval,
  deps: [ExecutionContext],
})
export class SendOfferLetterTool {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<LetterDelivered> {
    return Promise.resolve({ messageId: this.executionContext.step.idempotencyKey });
  }
}
