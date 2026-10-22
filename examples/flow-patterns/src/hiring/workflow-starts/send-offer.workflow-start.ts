import { WorkflowStart } from "agboss";
import { OfferRequestDto } from "../dtos/offer.dto.js";

/** Where sending an offer starts: the candidate and the role. */
@WorkflowStart({
  name: "send-offer-workflow-start",
  description: "An offer to make",
  input: OfferRequestDto,
})
export class SendOfferWorkflowStart {}
