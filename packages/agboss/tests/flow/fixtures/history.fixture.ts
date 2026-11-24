import { onAction, caseOf, onStart } from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { historyOf, oneOf, variant } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "./budgets.js";
import { DraftChangesDto } from "./data-dtos.js";
import { ChangesRequestedDto, DraftApprovedDto, OfferDraftDto, ShortlistDto } from "./dtos.js";
import { EmptyEnvironment, inline } from "../../../src/index.js";

/**
 * #299 S56 — earlier versions without tags: the review loop's reviewer reads
 * `historyOf(OfferDraftDto, { maxPrevious: 2 })` (the current draft and the two before it), the finish
 * reads every version (`historyOf(OfferDraftDto)`). The editor's draft replaces the old one, whose
 * versions are the history's `previous`.
 */

/** What the reviewer read on each visit, oldest visit first (reset with `resetReviews`). */
export const reviews: InputOf<ReviewDraftAction>[] = [];

export const resetReviews = (): void => {
  reviews.length = 0;
};

@WorkflowStart({
  name: "history-offer-workflow-start",
  description: "A shortlist to make an offer from",
  input: ShortlistDto,
})
export class HistoryOfferWorkflowStart {}

@Agent({
  name: "first-draft-agent",
  description: "Drafts the offer",
  prompt: inline("Draft the offer."),
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: OfferDraftDto,
})
export class FirstDraftAgent {}

/** Approves the fourth draft; asks for changes before. */
@Action({
  name: "review-draft-action",
  description: "Reviews the latest draft against the two before it",
  input: {
    draft: historyOf(OfferDraftDto, { maxPrevious: 2 }),
  },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
})
export class ReviewDraftAction implements ActionHandler<ReviewDraftAction> {
  execute(input: InputOf<ReviewDraftAction>): Promise<OutputOf<ReviewDraftAction>> {
    reviews.push(input);
    const { current, previous } = input.draft;
    return Promise.resolve(
      previous.length >= 2 && current.value.text.endsWith("v4")
        ? variant(DraftApprovedDto, {})
        : variant(ChangesRequestedDto, { notes: `after ${String(previous.length)} versions` }),
    );
  }
}

@Agent({
  name: "draft-editor-agent",
  description: "Rewrites the draft",
  prompt: inline("Rewrite the draft."),
  model: "moonshotai/kimi-k2.6",
  input: {
    draft: OfferDraftDto,
    changes: ChangesRequestedDto,
  },
  output: OfferDraftDto,
  maxVisits: 3,
})
export class DraftEditorAgent {}

/** Every version of the draft, oldest first: what the loop went through. */
@Action({
  name: "draft-history-action",
  description: "The drafts the offer went through",
  input: {
    drafts: historyOf(OfferDraftDto),
  },
  output: DraftChangesDto,
})
export class DraftHistoryAction {
  async execute(input: InputOf<DraftHistoryAction>): Promise<OutputOf<DraftHistoryAction>> {
    const { current, previous } = input.drafts;
    return {
      changes: [...previous, current]
        .map((draft) => draft.value.text)
        .join(" → "),
    };
  }
}

@WorkflowFinish({
  name: "draft-history-workflow-finish",
  description: "The drafts the offer went through",
  output: DraftChangesDto,
})
export class DraftHistoryWorkflowFinish {}

export const historyPaths = [
  onStart(HistoryOfferWorkflowStart)
    .toAgent(FirstDraftAgent)
    .toAction(ReviewDraftAction),
  onAction(ReviewDraftAction)
    .switch(
      caseOf(ChangesRequestedDto)
        .toAgent(DraftEditorAgent)
        .toAction(ReviewDraftAction),
      caseOf(DraftApprovedDto)
        .toAction(DraftHistoryAction)
        .toFinish(DraftHistoryWorkflowFinish),
    ),
] as const;

@Workflow({
  name: "history-offer-workflow",
  version: "1.0.0",
  flow: historyPaths,
})
export class HistoryOfferWorkflow {}

@Application({
  name: "history-offer-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HistoryOfferWorkflow],
  budgets: TEST_BUDGETS,
})
export class HistoryOfferApplication {}
