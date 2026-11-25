import { PiiFileAction, PiiKind, PiiPolicy } from "@agboss/core";

/**
 * What the KYC agent's model never sees as it is: a card number and an ID number are blacked
 * out of the photo (`FileView.Redacted`) before it goes to the model; a social security number refuses
 * the file. The original photo is not allowed through (`files: PiiFileAction.Mask`, the default).
 */
@PiiPolicy({
  name: "id-card-pii-policy",
  description: "Black out card numbers and ID numbers in a photo; refuse an SSN",
  rules: [
    PiiKind.CardNumber.mask(),
    PiiKind.IsraeliId.mask(),
    PiiKind.UsSsn.block("Please do not send an SSN."),
  ],
  // a block rule refuses an image whole by default: what a model says an image holds is a guardrail, not a
  // guarantee. This policy accepts that for the KYC photo — its model redactor decides, an SSN found refuses.
  files: PiiFileAction.RedactWithModel,
})
export class IdCardPiiPolicy {}
