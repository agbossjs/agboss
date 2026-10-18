import { describe, expect, it } from "vitest";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import {
  analyseWorkflow,
  inputShapesOf,
  type FlowAnalysis,
} from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
  WorkflowStartTextDto,
} from "../fixtures/dtos.js";
import {
  ExpertDraftDto,
  FastDraftDto,
  LoyaltyOfferDto,
  OrderStatusDto,
} from "../fixtures/data-dtos.js";
import {
  DraftAgent,
  EditorAgent,
  NotifyRecruiterAction,
  OfferFailedWorkflowFinish,
  OfferSentWorkflowFinish,
  OfferWorkflow,
  OfferWorkflowStart,
  ReviewerAgent,
  SendOfferAction,
  VisitsLimitExceededError,
} from "../fixtures/offer.fixture.js";
import { agent, caseOf, route, start, toAction } from "../fixtures/paths.js";
import {
  AnswerRouter,
  ExpertAnswerAgent,
  FastAnswerAgent,
  LoyaltyAgent,
  OrderAgent,
  SupportWorkflow,
  SupportWorkflowFinish,
  SupportWorkflowStart,
} from "../fixtures/support.fixture.js";

/** Position never carries meaning (#272 AC9): only the order of steps inside a path does. */

@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  flow: [
    agent(ExpertAnswerAgent).returns(ExpertDraftDto).toFinish(SupportWorkflowFinish),
    start(SupportWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OrderAgent)
      .returns(OrderStatusDto)
      .toRouter(AnswerRouter)
      .chooseOne(
        route(ExpertAnswerAgent),
        route(LoyaltyAgent).returns(LoyaltyOfferDto).toAgent(ExpertAnswerAgent),
        route(FastAnswerAgent).returns(FastDraftDto).toFinish(SupportWorkflowFinish),
      ),
  ],
})
class ReorderedSupportWorkflow {}

@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: [
    agent(ReviewerAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(DraftApprovedDto)
          .toAction(SendOfferAction)
          .returns(OfferSentDto)
          .toFinish(OfferSentWorkflowFinish),
        caseOf(ChangesRequestedDto, { about: OfferDraftDto })
          .toAgent(EditorAgent)
          .onError(
            VisitsLimitExceededError,
            toAction(NotifyRecruiterAction).toFinish(OfferFailedWorkflowFinish),
          )
          .returns(OfferDraftDto)
          .toAgent(ReviewerAgent),
      ),
    start(OfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewerAgent),
  ],
})
class ReorderedOfferWorkflow {}

/** Everything the analysis gives: the graph, every node's input shapes, the warnings. */
const describeAnalysis = (analysis: FlowAnalysis) => ({
  graph: analysis.graph,
  shapes: [...analysis.graph.nodes.keys()].map((node) => inputShapesOf(analysis, node)),
  warnings: analysis.warnings,
});

describe("AC9: reordering does not change the graph", () => {
  it("permuted paths and router routes give an identical analysed graph", () => {
    expect(describeAnalysis(analyseWorkflow(ReorderedSupportWorkflow))).toEqual(
      describeAnalysis(analyseWorkflow(SupportWorkflow)),
    );
  });

  it("permuted switch cases give an identical analysed graph", () => {
    expect(describeAnalysis(analyseWorkflow(ReorderedOfferWorkflow))).toEqual(
      describeAnalysis(analyseWorkflow(OfferWorkflow)),
    );
  });
});
