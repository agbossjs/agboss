import { PauseRespondent } from "@agboss/core";
import { LetterDelivery } from "../dto/send-offer-letter.dto.js";
import { ToolApproval } from "../../../../../packages/agboss/src/channels/pause-targets.js";
import { days } from "../../../../../packages/agboss/src/units/index.js";

/** The role a letter is approved through: the thread's owner — the recruiter — answers. */
@ToolApproval({
  name: "recruiter-tool-approval",
  description: "The recruiter approves an offer letter",
  input: LetterDelivery,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class RecruiterToolApproval {}
