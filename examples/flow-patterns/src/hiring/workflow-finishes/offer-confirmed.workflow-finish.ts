import { WorkflowFinish } from "agboss";
import { OfferConfirmedDto } from "../dtos/offer.dto.js";

/** The offer is sent and confirmed: committed, nothing undoes it. */
@WorkflowFinish({
  name: "offer-confirmed-workflow-finish",
  description: "The offer is confirmed",
  output: OfferConfirmedDto,
})
export class OfferConfirmedWorkflowFinish {}
