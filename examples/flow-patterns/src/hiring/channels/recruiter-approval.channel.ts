import { PauseRespondent, ToolApproval } from "@agboss/core";
import { LetterDelivery } from "../dto/send-offer-letter.dto.js";
import { days } from "@agboss/core/units";

/** The role a letter is approved through: the thread's owner — the recruiter — answers. */
@ToolApproval({
  name: "recruiter-tool-approval",
  description: "The recruiter approves an offer letter",
  input: LetterDelivery,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class RecruiterToolApproval {}
