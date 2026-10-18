import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { OfferDraftDto, ShortlistDto } from "./dtos.js";
import {
  BrokenAgent,
  DraftAgent,
  OfferFailedWorkflowFinish,
  OfferWorkflowStart,
} from "./offer.fixture.js";
import { start } from "./paths.js";

/**
 * A workflow whose broken-agent reads what no path gives (`[input.missing-on-path]`): its generated
 * `InputOf` is the rule's message, so the typed builder refuses `.toAgent(BrokenAgent)` (#272 AC2).
 * Written with the untyped helpers — the typed builder would not let it compile.
 */
@Workflow({
  name: "broken-offer-workflow",
  version: "1.0.0",
  flow: [
    start(OfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftAgent)
      .returns(OfferDraftDto)
      .toAgent(BrokenAgent)
      .returns(OfferDraftDto)
      .toFinish(OfferFailedWorkflowFinish),
  ],
})
export class BrokenOfferWorkflow {}
