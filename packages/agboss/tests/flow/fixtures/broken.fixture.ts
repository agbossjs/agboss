import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { listOf } from "../../../src/flow/dto-wrappers.js";
import { CompanyDto } from "./data-dtos.js";
import { OfferDraftDto, ShortlistDto, WorkflowStartTextDto } from "./dtos.js";
import { CompanyCheckDto, RankingDto } from "./launch-dtos.js";
import {
  RankerAgent,
  RankingWorkflowFinish,
  ScreeningAgent,
  ScreeningWorkflowStart,
} from "./launch.fixture.js";
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

/**
 * #273 — a per-item launch whose target reads no item (`[launch.item-not-read]`): its generated
 * `InputOf` is the rule's message, so the typed builder refuses `.toParallelAgents(ItemBlindAgent)`.
 */
@Agent({
  name: "item-blind-agent",
  description: "Checks a company without reading it",
  prompt: "Check the company.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: CompanyCheckDto,
})
export class ItemBlindAgent {}

@Workflow({
  name: "broken-screening-workflow",
  version: "1.0.0",
  flow: [
    start(ScreeningWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ScreeningAgent)
      .returns(listOf(CompanyDto))
      .toParallelAgents(ItemBlindAgent, { maxItems: 5 })
      .join()
      .returns(listOf(CompanyCheckDto))
      .toAgent(RankerAgent)
      .returns(RankingDto)
      .toFinish(RankingWorkflowFinish),
  ],
})
export class BrokenScreeningWorkflow {}
