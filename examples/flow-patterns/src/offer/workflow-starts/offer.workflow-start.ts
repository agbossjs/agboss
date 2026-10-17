import { WorkflowStart } from "agboss";
import { ShortlistDto } from "../dtos/shortlist.dto.js";

/** Where a run starts: the shortlist to make an offer from. */
@WorkflowStart({
  name: "offer-workflow-start",
  description: "A shortlist to make an offer from",
  input: ShortlistDto,
})
export class OfferWorkflowStart {}
