import { WorkflowFinish } from "@agboss/core";
import { OfferRequestDto } from "../../dto/offer.dto.js";

/** The offer could not be made: its steps were undone (or handed to a person) — the request. */
@WorkflowFinish({
  name: "offer-withdrawn-workflow-finish",
  description: "The offer was not made",
  output: OfferRequestDto,
})
export class OfferWithdrawnWorkflowFinish {}
