import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
} from "./dtos.js";
import { inline } from "../../../src/index.js";

/**
 * Components the analyser's tests wire into small flows, right and wrong (the offer review of #272
 * example 2a, in parts). Each test declares its own `@Workflow` from them.
 */

@WorkflowStart({
  name: "kit-workflow-start",
  description: "A shortlist",
  input: ShortlistDto,
})
export class KitWorkflowStart {}

@WorkflowStart({
  name: "second-kit-workflow-start",
  description: "A ready draft to edit",
  input: OfferDraftDto,
})
export class SecondKitWorkflowStart {}

@Agent({
  name: "draft-kit-agent",
  description: "Drafts the offer",
  prompt: inline("Draft it."),
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: OfferDraftDto,
})
export class DraftKitAgent {}

@Agent({
  name: "review-kit-agent",
  description: "Reviews the draft",
  prompt: inline("Review it."),
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
  },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
})
export class ReviewKitAgent {}

@Agent({
  name: "edit-kit-agent",
  description: "Edits the draft",
  prompt: inline("Edit it."),
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
  },
  output: OfferDraftDto,
  executionLimits: { maxVisits: 2 },
})
export class EditKitAgent {}

@Agent({
  name: "polish-kit-agent",
  description: "Polishes the draft, with no limit of its own",
  prompt: inline("Polish it."),
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
  },
  output: OfferDraftDto,
})
export class PolishKitAgent {}

@Action({
  name: "send-kit-action",
  description: "Sends the offer",
  input: {
    draft: OfferDraftDto,
  },
  output: OfferSentDto,
})
export class SendKitAction {
  async execute(): Promise<OfferSentDto> {
    return Promise.resolve({ delivered: true });
  }
}

@Action({
  name: "notify-kit-action",
  description: "Tells the recruiter",
  input: {
    draft: OfferDraftDto,
  },
})
export class NotifyKitAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@WorkflowFinish({
  name: "sent-kit-workflow-finish",
  description: "The offer was sent",
  output: OfferSentDto,
})
export class SentKitWorkflowFinish {}

@WorkflowFinish({
  name: "draft-kit-workflow-finish",
  description: "The draft",
  output: OfferDraftDto,
})
export class DraftKitWorkflowFinish {}

@Router({
  name: "kit-router",
  description: "Edits the draft again or sends it",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  input: {
    draft: OfferDraftDto,
  },
  maxVisits: 3,
  routes: [
    { target: EditKitAgent, prompt: "The draft needs work" },
    { target: DraftKitWorkflowFinish, prompt: "Stop and send the answer: the draft is good" },
  ],
})
export class KitRouter {}
