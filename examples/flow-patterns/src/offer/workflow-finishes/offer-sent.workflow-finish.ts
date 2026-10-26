import { WorkflowFinish } from "@agboss/core";
import { OfferSentDto } from "../dtos/offer-sent.dto.js";

/** Where a run finishes when the approved offer went out. */
@WorkflowFinish({
  name: "offer-sent-workflow-finish",
  description: "The offer was sent",
  output: OfferSentDto,
})
export class OfferSentWorkflowFinish {}
