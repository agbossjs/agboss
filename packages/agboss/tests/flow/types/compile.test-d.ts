import { describe, expectTypeOf, it } from "vitest";
import { onAgent, caseOf, onStart } from "../../../src/flow/builder.js";
import {
  historyOf,
  oneOf,
  optional,
  type HistoryOf,
  type Produced,
} from "../../../src/flow/dto-wrappers.js";
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
    reviewed.switch(
      caseOf(ChangesRequestedDto).toAgent(EditorAgent),
      caseOf(DraftApprovedDto).toAction(SendOfferAction),
    );
  });

  it("AC3: from(Dto, tag) does not exist; historyOf is HistoryOf<Produced<…>> in InputOf (AC4)", () => {
    expectTypeOf<typeof import("../../../src/index.js")>().not.toHaveProperty("from");
    expectTypeOf<typeof import("../../../src/index.js")>().not.toHaveProperty("about");
    expectTypeOf<typeof import("../../../src/dto/index.js")>().not.toHaveProperty("about");
    expectTypeOf<InputOf<ReviewDraftAction>>().toEqualTypeOf<{
      draft: HistoryOf<Produced<OfferDraftDto, typeof DraftEditorAgent | typeof FirstDraftAgent>>;
    }>();
    expectTypeOf<InputOf<DraftHistoryAction>["drafts"]["previous"]>().toEqualTypeOf<
      readonly Produced<OfferDraftDto, typeof DraftEditorAgent | typeof FirstDraftAgent>[]
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
    verdict.switch(
      caseOf(ApprovedVerdictDto).toFinish(ApprovedWorkflowFinish),
      caseOf(RejectedVerdictDto).toFinish(RejectedWorkflowFinish),
    );
    verdict.switch(
      // @ts-expect-error — the switch is not exhaustive: RejectedVerdictDto has no case
      caseOf(ApprovedVerdictDto).toFinish(ApprovedWorkflowFinish),
      caseOf(ApprovedVerdictDto).toFinish(RejectedWorkflowFinish),
    );
    expectTypeOf<ApprovedVerdictDto>().not.toEqualTypeOf<RejectedVerdictDto>();
    expectTypeOf<AGBossTypes.DtoBrands["ApprovedVerdictDto"]>().toEqualTypeOf<ApprovedVerdictDto>();
  });

  it("the brand is optional: project code creates DTO values as before", () => {
    const verdict: ApprovedVerdictDto = { note: "fine" };
    expectTypeOf(verdict.note).toEqualTypeOf<string>();
  });
});

describe("#270 AC8: Produced P is the producer union", () => {
  it("a field one of two producers can bring", () => {
    expectTypeOf<InputOf<ReviewerAgent>>().toEqualTypeOf<{
      draft: Produced<OfferDraftDto, typeof DraftAgent | typeof EditorAgent>;
    }>();
    expectTypeOf<InputOf<FastAnswerAgent>["order"]["producer"]>().not.toBeNever();
  });
});

describe("#270 AC13: InputOf is path-sensitive — optional fields narrow without !", () => {
  it("an optional field some paths bring", () => {
    const input = {} as InputOf<ExpertAnswerAgent>;
    if (input.loyalty !== undefined) {
      expectTypeOf(input.loyalty.value).toEqualTypeOf<LoyaltyOfferDto>();
    } else {
      expectTypeOf(input.loyalty).toEqualTypeOf<undefined>();
    }
  });

  it("two fields of which every path brings exactly one", () => {
    const input = {} as InputOf<SupportAction>;
    if (input.fast === undefined) {
      expectTypeOf(input.expert.value).toEqualTypeOf<ExpertDraftDto>();
    } else {
      expectTypeOf(input.fast.value).toEqualTypeOf<FastDraftDto>();
    }
  });

  it("a list field is an array of Produced elements", () => {
    expectTypeOf<InputOf<BatchRankAgent>>().toEqualTypeOf<{
      companies: readonly Produced<CompanyDto, typeof CompanyBatchWorkflowStart>[];
    }>();
  });
});

describe("#270 AC13 / AC21: WorkflowStarts types app.execute's input and result.output", () => {
  it("a map start's input; the outputs of the finishes it reaches", () => {
    expectTypeOf<AGBossTypes.WorkflowStarts["company-check-workflow-start"]>().toEqualTypeOf<{
      input: { company: CompanyDto; request?: SearchRequestDto };
      output: CompanyScoreDto;
    }>();
    expectTypeOf<InputOf<CompanyCheckWorkflowStart>>().toEqualTypeOf<{
      company: CompanyDto;
      request?: SearchRequestDto;
    }>();
    expectTypeOf<OutputOf<SupportAction>>().not.toEqualTypeOf<ShortlistDto>();
  });
});
