import { describe, expectTypeOf, it } from "vitest";
import type { FlowPath } from "../../../src/flow/ast.js";
import { onAgent, onStart, toAction, toAgent, toFinish } from "../../../src/flow/builder.js";
import { historyOf, oneOf, optional, type HistoryOf } from "../../../src/flow/dto-wrappers.js";
import { Metadata, type Tracked } from "../../../src/flow/metadata.js";
import type {
  AGBossTypes,
  InputOf,
  OutputOf,
  ProducerOutputOf,
} from "../../../src/flow/generated-types.js";
import {
  CompanyDto,
  CompanyScoreDto,
  FastDraftDto,
  ExpertDraftDto,
  LoyaltyOfferDto,
  SearchRequestDto,
} from "../fixtures/data-dtos.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftEditorAgent,
  DraftHistoryAction,
  FirstDraftAgent,
  ReviewDraftAction,
} from "../fixtures/history.fixture.js";
import {
  ApprovedVerdictDto,
  ApprovedWorkflowFinish,
  RejectedVerdictDto,
  RejectedWorkflowFinish,
  VerdictAgent,
} from "../fixtures/markers.fixture.js";
import {
  DraftAgent,
  EditorAgent,
  OfferSentWorkflowFinish,
  ReviewerAgent,
  SendOfferAction,
} from "../fixtures/offer.fixture.js";
import {
  BatchRankAgent,
  CompanyBatchWorkflowStart,
  CompanyCheckAgent,
  CompanyCheckWorkflowStart,
} from "../fixtures/starts.fixture.js";
import { ExpertAnswerAgent, FastAnswerAgent, SupportAction } from "../fixtures/support.fixture.js";
import {
  CompanyGradedWorkflowFinish,
  CompanyRejectedWorkflowFinish,
  CompanyReviewFailedWorkflowFinish,
  CompanyReviewerAgent,
  CompanyReviewWorkflow,
  CompanyReviewWorkflowStart,
} from "../fixtures/children.fixture.js";
import { TreasuryWorkflowFinish } from "../fixtures/replies.fixture.js";

/**
 * Compile-time checks of the generated `.agboss/types.d.ts` (#272 PR 3, #270 → Generated types),
 * written for the fixtures by `check:types` before typecheck. Each `@ts-expect-error` is a negative
 * test: tsc fails this file if the line compiles.
 */

describe("#270 AC6, #299 S54: returns and caseOf against ProducerOutputs", () => {
  it("a map start names its fields in a chain of .returns, in any order", () => {
    onStart(CompanyCheckWorkflowStart).toAgent(CompanyCheckAgent);
    onStart(CompanyCheckWorkflowStart).toAgent(CompanyCheckAgent);
    const named = onStart(CompanyCheckWorkflowStart);
    expectTypeOf<ProducerOutputOf<CompanyCheckWorkflowStart>>().toEqualTypeOf<
      readonly [CompanyDto, SearchRequestDto | undefined]
    >();
  });

  it("AC3: one value per .returns — the multi-argument form and { as } do not compile", () => {
    // @ts-expect-error — { about } is gone from caseOf too (#1277)
    caseOf(ChangesRequestedDto, { about: OfferDraftDto });
    onStart(CompanyBatchWorkflowStart);
    onAgent(DraftAgent);
  });

  it("AC3: a oneOf output is, then .switch(…)", () => {
    const reviewed = onAgent(ReviewerAgent);
    // @ts-expect-error — after comes its .switch, not a transition
    reviewed.toAgent(EditorAgent);
    reviewed.toOneOf([toAgent(EditorAgent), toAction(SendOfferAction)]);
  });

  it("1275a: a oneOf output is branched by .toOneOf([…side paths]) — no DTO named", () => {
    const reviewed = onAgent(ReviewerAgent);
    reviewed.toOneOf([toAgent(EditorAgent), toAction(SendOfferAction)]);
    // @ts-expect-error — one branch is no choice: two or more side paths
    reviewed.toOneOf([toAgent(EditorAgent)]);
    // @ts-expect-error — the branches are an array, not arguments
    reviewed.toOneOf(toAgent(EditorAgent), toAction(SendOfferAction));
    // @ts-expect-error — a caseOf(…) path is not a side path
    reviewed.toOneOf([toAgent(EditorAgent), toAgent(EditorAgent)]);
    // @ts-expect-error — a step that gives one class has nothing to branch
    onAgent(DraftAgent).toOneOf([toAgent(EditorAgent), toAction(SendOfferAction)]);
    // @ts-expect-error — a transition right after a oneOf output is not offered
    reviewed.toAction(SendOfferAction);
  });

  it("1275c: the branches read each variant once; one branch may read none and takes the one left", () => {
    const reviewed = onAgent(ReviewerAgent);
    // EditorAgent reads ChangesRequestedDto; SendOfferAction reads no variant: it takes the other
    reviewed.toOneOf([toAgent(EditorAgent), toAction(SendOfferAction)]);
    reviewed.toOneOf([toAction(SendOfferAction), toAgent(EditorAgent)]);
    // @ts-expect-error — two branches read ChangesRequestedDto
    reviewed.toOneOf([toAgent(EditorAgent), toAgent(EditorAgent)]);
    // @ts-expect-error — two branches read no variant: only one may take the one left
    reviewed.toOneOf([toAction(SendOfferAction), toAction(SendOfferAction)]);
  });

  it("1275c: a child's .onFinish chain is a path only when every finish is named, once", () => {
    const child = () => onStart(CompanyCheckWorkflowStart).toWorkflow(CompanyReviewWorkflow);
    const path = (flow: FlowPath): FlowPath => flow;
    path(
      child()
        .onFinish(CompanyGradedWorkflowFinish, toAgent(CompanyReviewerAgent))
        .onFinish(CompanyRejectedWorkflowFinish, toAgent(CompanyReviewerAgent))
        .onFinish(CompanyReviewFailedWorkflowFinish, toAgent(CompanyReviewerAgent)),
    );
    path(
      // @ts-expect-error — CompanyReviewFailedWorkflowFinish has no .onFinish
      child()
        .onFinish(CompanyGradedWorkflowFinish, toAgent(CompanyReviewerAgent))
        .onFinish(CompanyRejectedWorkflowFinish, toAgent(CompanyReviewerAgent)),
    );
    child()
      .onFinish(CompanyGradedWorkflowFinish, toAgent(CompanyReviewerAgent))
      // @ts-expect-error — a finish is named once
      .onFinish(CompanyGradedWorkflowFinish, toAgent(CompanyReviewerAgent));
  });

  it("1275b: .onFinish(ChildFinish, subPath) follows a child with two or more finishes", () => {
    const reviewed = onStart(CompanyReviewWorkflowStart).toWorkflow(CompanyReviewWorkflow);
    reviewed.onFinish(CompanyGradedWorkflowFinish, toAgent(CompanyReviewerAgent));
    reviewed
      .onFinish(CompanyGradedWorkflowFinish, toAgent(CompanyReviewerAgent))
      .onFinish(CompanyRejectedWorkflowFinish, toAgent(CompanyReviewerAgent));
    // @ts-expect-error — a finish of another workflow is no finish of this child
    reviewed.onFinish(ChangesRequestedDto, toAgent(CompanyReviewerAgent));
    // @ts-expect-error — a finish of another workflow is no finish of this child
    reviewed.onFinish(OfferSentWorkflowFinish, toAgent(CompanyReviewerAgent));
    // @ts-expect-error — the path of a finish is a side path, not a caseOf(…)
    reviewed.onFinish(CompanyGradedWorkflowFinish, caseOf(ChangesRequestedDto));
    // @ts-expect-error — an agent is no child workflow
    onAgent(DraftAgent).onFinish(CompanyGradedWorkflowFinish, toAgent(CompanyReviewerAgent));
    expectTypeOf<AGBossTypes.WorkflowFinishes["treasury-workflow"]>().toEqualTypeOf<
      typeof TreasuryWorkflowFinish
    >();
  });

  it("AC3: from(Dto, tag) does not exist; historyOf is HistoryOf<Tracked<…>> in InputOf (AC4)", () => {
    expectTypeOf<typeof import("../../../src/index.js")>().not.toHaveProperty("from");
    expectTypeOf<typeof import("../../../src/index.js")>().not.toHaveProperty("about");
    expectTypeOf<typeof import("../../../src/dto/index.js")>().not.toHaveProperty("about");
    expectTypeOf<InputOf<ReviewDraftAction>>().toEqualTypeOf<{
      draft: HistoryOf<Tracked<OfferDraftDto, typeof DraftEditorAgent | typeof FirstDraftAgent>>;
    }>();
    expectTypeOf<InputOf<DraftHistoryAction>["drafts"]["previous"]>().toEqualTypeOf<
      readonly Tracked<OfferDraftDto, typeof DraftEditorAgent | typeof FirstDraftAgent>[]
    >();
    expectTypeOf(historyOf(OfferDraftDto, { maxPrevious: 2 }).maxPrevious).toEqualTypeOf<
      number | undefined
    >();
  });

  it("a list start returns its list; a single producer one value", () => {
    onStart(CompanyBatchWorkflowStart);
    onStart(CompanyCheckWorkflowStart).toAgent(CompanyCheckAgent);
    expectTypeOf<ProducerOutputOf<CompanyBatchWorkflowStart>>().toEqualTypeOf<
      readonly CompanyDto[]
    >();
  });
});

describe("S39: DTO brands tell two DTOs of the same shape apart", () => {
  it("a case for one of two same-shaped DTOs twice does not compile", () => {
    const verdict = onAgent(VerdictAgent);
    verdict.toOneOf([toFinish(ApprovedWorkflowFinish), toFinish(RejectedWorkflowFinish)]);
    // @ts-expect-error — the branches are not exhaustive: RejectedVerdictDto has none
    verdict.toOneOf([toFinish(ApprovedWorkflowFinish), toFinish(ApprovedWorkflowFinish)]);
    expectTypeOf<ApprovedVerdictDto>().not.toEqualTypeOf<RejectedVerdictDto>();
    expectTypeOf<AGBossTypes.DtoBrands["ApprovedVerdictDto"]>().toEqualTypeOf<ApprovedVerdictDto>();
  });

  it("the brand is optional: project code creates DTO values as before", () => {
    const verdict: ApprovedVerdictDto = { note: "fine" };
    expectTypeOf(verdict.note).toEqualTypeOf<string>();
  });
});

describe("#270 AC8: Tracked P is the producer union", () => {
  it("a field one of two producers can bring", () => {
    expectTypeOf<InputOf<ReviewerAgent>>().toEqualTypeOf<{
      draft: Tracked<OfferDraftDto, typeof DraftAgent | typeof EditorAgent>;
    }>();
    expectTypeOf(Metadata.createdBy({} as InputOf<FastAnswerAgent>["order"])).not.toBeNever();
  });
});

describe("#270 AC13: InputOf is path-sensitive — optional fields narrow without !", () => {
  it("an optional field some paths bring", () => {
    const input = {} as InputOf<ExpertAnswerAgent>;
    if (input.loyalty !== undefined) {
      expectTypeOf(input.loyalty).toExtend<LoyaltyOfferDto>();
    } else {
      expectTypeOf(input.loyalty).toEqualTypeOf<undefined>();
    }
  });

  it("two fields of which every path brings exactly one", () => {
    const input = {} as InputOf<SupportAction>;
    if (input.fast === undefined) {
      expectTypeOf(input.expert).toExtend<ExpertDraftDto>();
    } else {
      expectTypeOf(input.fast).toExtend<FastDraftDto>();
    }
  });

  it("a list field is an array of Tracked elements", () => {
    expectTypeOf<InputOf<BatchRankAgent>>().toEqualTypeOf<{
      companies: readonly Tracked<CompanyDto, typeof CompanyBatchWorkflowStart>[];
    }>();
  });
});

describe("#270 AC13 / AC21: WorkflowStarts types app.execute's input and result.output", () => {
  it("a map start's input; the outputs of the finishes it reaches", () => {
    expectTypeOf<AGBossTypes.WorkflowStarts["company-check-workflow-start"]>().toEqualTypeOf<{
      input: { company: CompanyDto; request?: SearchRequestDto };
      output: CompanyScoreDto;
      readonly finishes: "company-score-workflow-finish";
    }>();
    expectTypeOf<InputOf<CompanyCheckWorkflowStart>>().toEqualTypeOf<{
      company: CompanyDto;
      request?: SearchRequestDto;
    }>();
    expectTypeOf<OutputOf<SupportAction>>().not.toEqualTypeOf<ShortlistDto>();
  });
});
