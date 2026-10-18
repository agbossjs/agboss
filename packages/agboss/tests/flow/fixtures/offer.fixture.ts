import { agent, caseOf, start, toAction } from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
  UnrelatedDto,
} from "./dtos.js";

/** #272 example 2a — a review loop: a node reached from two places has its own path. */

/** Stands in for #261's `VisitsLimitExceededError` until the runtime brings it (PR 4). */
export class VisitsLimitExceededError extends Error {}

@WorkflowStart({
  name: "offer-workflow-start",
  description: "A shortlist to make an offer from",
  input: ShortlistDto,
})
export class OfferWorkflowStart {}

@Agent({
  name: "draft-agent",
  description: "Drafts the offer",
  prompt: "Draft the offer.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: OfferDraftDto,
})
export class DraftAgent {}

@Agent({
  name: "reviewer-agent",
  description: "Reviews the draft",
  prompt: "Review the draft.",
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
  },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto), // what the changes are about: in the flow (#299)
})
export class ReviewerAgent {}

@Agent({
  name: "editor-agent",
  description: "Rewrites the draft by the review notes",
  prompt: "Rewrite the draft.",
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
    changes: ChangesRequestedDto,
  },
  output: OfferDraftDto,
  maxVisits: 2,
})
export class EditorAgent {}

/** Its generated input reports `[input.missing-on-path]`: no path brings an `UnrelatedDto`. */
@Agent({
  name: "broken-agent",
  description: "Reads what no path gives",
  prompt: "Read it.",
  model: "moonshotai/kimi-k2.6",
  input: {
    unrelated: UnrelatedDto,
  },
  output: OfferDraftDto,
})
export class BrokenAgent {}

@Action({
  name: "notify-recruiter-action",
  description: "Tells the recruiter the offer failed",
  input: {
    draft: OfferDraftDto,
  },
})
export class NotifyRecruiterAction implements ActionHandler<NotifyRecruiterAction> {
  async execute(input: InputOf<NotifyRecruiterAction>): Promise<void> {
    await Promise.resolve(input.draft.value.text);
  }
}

@Action({
  name: "send-offer-action",
  description: "Sends the approved offer",
  input: {
    draft: OfferDraftDto,
  },
  output: OfferSentDto,
})
export class SendOfferAction implements ActionHandler<SendOfferAction> {
  execute(input: InputOf<SendOfferAction>): Promise<OutputOf<SendOfferAction>> {
    return Promise.resolve({ delivered: input.draft.value.text.length > 0 });
  }
}

@WorkflowFinish({
  name: "offer-failed-workflow-finish",
  description: "The offer could not be made",
  output: OfferDraftDto,
})
export class OfferFailedWorkflowFinish {}

@WorkflowFinish({
  name: "offer-sent-workflow-finish",
  description: "The offer was sent",
  output: OfferSentDto,
})
export class OfferSentWorkflowFinish {}

export const offerPaths = [
  start(OfferWorkflowStart)
    .returns(ShortlistDto)
    .toAgent(DraftAgent)
    .returns(OfferDraftDto)
    .toAgent(ReviewerAgent),

  agent(ReviewerAgent)
    .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
    .switch(
      caseOf(ChangesRequestedDto, { about: OfferDraftDto })
        .toAgent(EditorAgent)
        .onError(
          VisitsLimitExceededError,
          toAction(NotifyRecruiterAction)
            .toFinish(OfferFailedWorkflowFinish),
        )
        .returns(OfferDraftDto)
        .toAgent(ReviewerAgent),
      caseOf(DraftApprovedDto)
        .toAction(SendOfferAction)
        .returns(OfferSentDto)
        .toFinish(OfferSentWorkflowFinish),
    ),
] as const;

@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: offerPaths,
})
export class OfferWorkflow {}
