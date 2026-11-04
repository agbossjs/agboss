/**
 * #643: a hand-set `maxSteps` below the worst case of a loop every cycle of which `maxVisits`
 * bounds is `[limits.max-steps-below-worst-case]` — the run would fail with
 * `StepsLimitExceededError` before the loop's `.onError(VisitsLimitExceededError, …)` ends it.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { boundedStepsFrom } from "../../../src/flow/analyse/strongly-connected.js";
import { walkFlow } from "../../../src/flow/analyse/walk.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { StepsLimitExceededError } from "../../../src/graph/limits.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftAgent,
  NotifyRecruiterAction,
  OfferFailedWorkflowFinish,
  OfferSentWorkflowFinish,
  OfferWorkflowStart,
  SendOfferAction,
  VisitsLimitExceededError,
  offerPaths,
} from "../fixtures/offer.fixture.js";
import { agent, caseOf, start, toAction } from "../fixtures/paths.js";
import type { ComponentName } from "../../../src/flow/registry.js";

const OFFER_START = "offer-workflow-start" as ComponentName;

/** The credit review of agboss-examples 09: an officer (maxVisits 4) and an editor (maxVisits 3). */
@Agent({
  name: "officer-agent",
  description: "Reviews the draft",
  prompt: "Review the draft.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: OfferDraftDto },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
  maxVisits: 4,
})
class OfficerAgent {}

@Agent({
  name: "rewriter-agent",
  description: "Rewrites the draft by the officer's notes",
  prompt: "Rewrite the draft.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: OfferDraftDto, changes: ChangesRequestedDto },
  output: OfferDraftDto,
  maxVisits: 3,
})
class RewriterAgent {}

const reviewPaths = (
  handled = VisitsLimitExceededError as abstract new (...args: never[]) => Error,
) => [
  start(OfferWorkflowStart)
    .returns(ShortlistDto)
    .toAgent(DraftAgent)
    .returns(OfferDraftDto)
    .toAgent(OfficerAgent),
  agent(OfficerAgent)
    .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
    .switch(
      caseOf(ChangesRequestedDto, { about: OfferDraftDto })
        .toAgent(RewriterAgent)
        .onError(handled, toAction(NotifyRecruiterAction).toFinish(OfferFailedWorkflowFinish))
        .returns(OfferDraftDto)
        .toAgent(OfficerAgent),
      caseOf(DraftApprovedDto)
        .toAction(SendOfferAction)
        .returns(OfferSentDto)
        .toFinish(OfferSentWorkflowFinish),
    ),
];

function reviewWith(maxSteps: number, handled?: abstract new (...args: never[]) => Error) {
  @Workflow({
    name: "review-steps-workflow",
    version: "1.0.0",
    maxSteps,
    flow: reviewPaths(handled),
  })
  class ReviewStepsWorkflow {}
  return ReviewStepsWorkflow;
}

function offerWith(maxSteps: number) {
  @Workflow({ name: "offer-steps-workflow", version: "1.0.0", maxSteps, flow: offerPaths })
  class OfferStepsWorkflow {}
  return OfferStepsWorkflow;
}

const warningsOf = (workflow: abstract new () => unknown) =>
  checkWorkflow(workflow).warnings.filter(
    (found) => found.code === "limits.max-steps-below-worst-case",
  );

describe("#643 AC1: a maxSteps below the bounded worst case of a loop warns", () => {
  it("AC1: officer 4 + rewriter 3 + draft 1 = 8 steps; maxSteps 7 names the loop", () => {
    expect(warningsOf(reviewWith(7)).map((found) => found.message)).toEqual([
      "review-steps-workflow: the worst case from offer-workflow-start takes 8 steps — through " +
        "officer-agent (maxVisits 4), rewriter-agent (maxVisits 3), but maxSteps is 7: a run that long " +
        "fails with StepsLimitExceededError before its maxVisits ends it — set maxSteps: 8",
    ]);
    expect(checkWorkflow(reviewWith(7)).errors).toEqual([]);
  });

  it("AC1: an unbounded node between the bounded visits counts once per bounded visit and once more", () => {
    // reviewer (no maxVisits) ↔ editor (maxVisits 2): draft 1 + editor 2 + reviewer 3 = 6
    expect(warningsOf(offerWith(5)).map((found) => found.message)).toEqual([
      expect.stringContaining(
        "takes 6 steps — through editor-agent (maxVisits 2), but maxSteps is 5",
      ),
    ]);
  });

  it("AC1: under --strict it is an error", () => {
    expect(
      checkWorkflow(reviewWith(7), { strict: true }).errors.map((found) => found.code),
    ).toEqual(["limits.max-steps-below-worst-case"]);
  });
});

describe("#643 AC2: what is not warned", () => {
  it("AC2: maxSteps at the worst case is clean", () => {
    expect(warningsOf(reviewWith(8))).toEqual([]);
    expect(warningsOf(offerWith(6))).toEqual([]);
  });

  it("AC2: a flow that takes the steps limit itself means a smaller maxSteps", () => {
    expect(warningsOf(reviewWith(7, StepsLimitExceededError))).toEqual([]);
  });

  it("AC2: without a hand-set maxSteps nothing new is checked", () => {
    @Workflow({ name: "review-default-workflow", version: "1.0.0", flow: reviewPaths() })
    class ReviewDefaultWorkflow {}
    expect(warningsOf(ReviewDefaultWorkflow)).toEqual([]);
  });

  it("AC2: the bound is exact for the walk of 09's loop and for a flow without a cycle", () => {
    const walked = walkFlow(reviewPaths());
    expect(boundedStepsFrom(walked.graph, OFFER_START)?.most).toBe(8);
    const straight = walkFlow([
      start(OfferWorkflowStart)
        .returns(ShortlistDto)
        .toAgent(DraftAgent)
        .returns(OfferDraftDto)
        .toFinish(OfferFailedWorkflowFinish),
    ]);
    expect(boundedStepsFrom(straight.graph, OFFER_START)).toEqual({
      most: 1,
      loops: [],
    });
  });
});
