import { WorkflowFinish } from "@agboss/core";
import { OfferDraftDto } from "../dtos/offer-draft.dto.js";

/** Where a run finishes when no draft was approved: the last draft. */
@WorkflowFinish({
  name: "offer-failed-workflow-finish",
  description: "The offer could not be made",
  output: OfferDraftDto,
})
export class OfferFailedWorkflowFinish {}
