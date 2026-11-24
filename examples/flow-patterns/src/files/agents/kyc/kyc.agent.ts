import { Agent, FileView, ModelFiles, inline } from "@agboss/core";
import { IdCheckRequestDto } from "../../dto/id-check-request.dto.js";
import { IdCardPiiPolicy } from "../../pii-policies/id-card.pii-policy.js";

/**
 * Checks that a photo is an ID card of the right kind, without ever seeing the personal data on it:
 * its model gets a redacted copy (`FileView.Redacted`) — the built-in image redactor, on a cheap vision
 * model, blacks out what `IdCardPiiPolicy` names. Needs the optional peer dependency `sharp`.
 */
@Agent({
  name: "kyc-agent",
  description: "Checks the kind of an ID photo on a redacted copy",
  prompt: inline(
    "Say what kind of document the photo shows and whether it looks intact. One line.",
  ),
  model: "google/gemini-2.5-flash-lite",
  input: { request: IdCheckRequestDto },
  piiPolicies: [IdCardPiiPolicy],
  files: ModelFiles.of({
    views: [FileView.Redacted],
    allowedMediaTypes: ["image/png", "image/jpeg"],
  }),
})
export class KycAgent {}
