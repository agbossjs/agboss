import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  BrokenAgent,
  DraftAgent,
  OfferFailedWorkflowFinish,
  OfferWorkflowStart,
} from "./offer.fixture.js";
import { onStart } from "./paths.js";

/**
 * A workflow whose broken-agent reads what no path gives (`[input.missing-on-path]`): its generated
 * `InputOf` is the rule's message, so the typed builder refuses `.toAgent(BrokenAgent)` (#272 AC2).
 * Written with the untyped helpers — the typed builder would not let it compile.
 */
@Workflow({
  name: "broken-offer-workflow",
  version: "1.0.0",
  flow: [
    onStart(OfferWorkflowStart)
      .toAgent(DraftAgent)
      .toAgent(BrokenAgent)
      .toFinish(OfferFailedWorkflowFinish),
  ],
})
export class BrokenOfferWorkflow {}
