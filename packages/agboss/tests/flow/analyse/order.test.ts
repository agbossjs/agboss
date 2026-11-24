import { describe, expect, it } from "vitest";
import {
  analyseWorkflow,
  inputShapesOf,
  type FlowAnalysis,
} from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { ChangesRequestedDto, DraftApprovedDto } from "../fixtures/dtos.js";
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
import { onAgent, caseOf, route, onStart, toAction } from "../fixtures/paths.js";
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
    onAgent(ExpertAnswerAgent).toFinish(SupportWorkflowFinish),
    onStart(SupportWorkflowStart)
      .toAgent(OrderAgent)
      .toRouter(AnswerRouter)
      .chooseOne(
        route(ExpertAnswerAgent),
        route(LoyaltyAgent).toAgent(ExpertAnswerAgent),
        route(FastAnswerAgent).toFinish(SupportWorkflowFinish),
      ),
  ],
})
class ReorderedSupportWorkflow {}

@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: [
    onAgent(ReviewerAgent).switch(
      caseOf(DraftApprovedDto).toAction(SendOfferAction).toFinish(OfferSentWorkflowFinish),
      caseOf(ChangesRequestedDto)
        .toAgent(EditorAgent)
        .onError(
          VisitsLimitExceededError,
          toAction(NotifyRecruiterAction).toFinish(OfferFailedWorkflowFinish),
        )
        .toAgent(ReviewerAgent),
    ),
    onStart(OfferWorkflowStart).toAgent(DraftAgent).toAgent(ReviewerAgent),
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
