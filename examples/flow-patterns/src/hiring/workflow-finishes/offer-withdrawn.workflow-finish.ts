import { WorkflowFinish } from "agboss";
import { OfferRequestDto } from "../dtos/offer.dto.js";

/** The offer could not be made: its steps were undone (or handed to a person) — the request. */
@WorkflowFinish({
  name: "offer-withdrawn-workflow-finish",
  description: "The offer was not made",
  output: OfferRequestDto,
})
export class OfferWithdrawnWorkflowFinish {}
