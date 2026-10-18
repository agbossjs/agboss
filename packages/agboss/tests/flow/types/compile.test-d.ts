import { describe, expectTypeOf, it } from "vitest";
import { agent, caseOf, start } from "../../../src/flow/builder.js";
import {
  historyOf,
  listOf,
  oneOf,
  optional,
  type HistoryOf,
  type Produced,
} from "../../../src/flow/dto-wrappers.js";
import type {
  DtoBrands,
  InputOf,
  OutputOf,
  ProducerOutputOf,
  WorkflowStarts,
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
  ProfileDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftEditorAgent,
  DraftHistoryWorkflowFinish,
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
import {
  ExpertAnswerAgent,
  FastAnswerAgent,
  SupportWorkflowFinish,
} from "../fixtures/support.fixture.js";

/**
 * Compile-time checks of the generated `.agboss/types.d.ts` (#272 PR 3, #270 → Generated types),
 * written for the fixtures by `check:types` before typecheck. Each `@ts-expect-error` is a negative
 * test: tsc fails this file if the line compiles.
 */

describe("#270 AC6, #299 S54: returns and caseOf against ProducerOutputs", () => {
  it("a map start names its fields in a chain of .returns, in any order", () => {
    start(CompanyCheckWorkflowStart)
      .returns(CompanyDto)
      .returns(optional(SearchRequestDto))
      .toAgent(CompanyCheckAgent);
    start(CompanyCheckWorkflowStart)
      .returns(optional(SearchRequestDto))
      .returns(CompanyDto)
      .toAgent(CompanyCheckAgent);
    // @ts-expect-error — the start gives an optional SearchRequestDto too: name it before .toAgent
    start(CompanyCheckWorkflowStart).returns(CompanyDto).toAgent(CompanyCheckAgent);
    // @ts-expect-error — the request is optional(SearchRequestDto), not a SearchRequestDto
    start(CompanyCheckWorkflowStart).returns(CompanyDto).returns(SearchRequestDto);
    // @ts-expect-error — the CompanyDto is named already
    start(CompanyCheckWorkflowStart).returns(CompanyDto).returns(CompanyDto);
    const named = start(CompanyCheckWorkflowStart)
      .returns(CompanyDto)
      .returns(optional(SearchRequestDto));
    // @ts-expect-error — the start gives two values, not three
    named.returns(ProfileDto);
    expectTypeOf<ProducerOutputOf<CompanyCheckWorkflowStart>>().toEqualTypeOf<
      readonly [CompanyDto, SearchRequestDto | undefined]
    >();
  });

  it("AC3: one value per .returns — the multi-argument form and { as } do not compile", () => {
    // @ts-expect-error — several values are a chain: .returns(CompanyDto).returns(optional(…))
    start(CompanyCheckWorkflowStart).returns(CompanyDto, optional(SearchRequestDto));
    // @ts-expect-error — no string tags (#299 S56): { as } is gone
    agent(DraftAgent).returns(OfferDraftDto, { as: "before" });
    // @ts-expect-error — { about } names DTO classes
    agent(DraftAgent).returns(OfferDraftDto, { about: "ShortlistDto" });
    // @ts-expect-error — a start's input is no answer about anything: no { about } after a start
    start(CompanyBatchWorkflowStart).returns(listOf(CompanyDto), { about: ShortlistDto });
    agent(DraftAgent).returns(OfferDraftDto, { about: ShortlistDto });
    agent(DraftAgent).returns(OfferDraftDto, { about: [ShortlistDto, ProfileDto] });
  });

  it("AC3: { about } goes on the case of a oneOf, never on .returns(oneOf(…))", () => {
    const reviewed = agent(ReviewerAgent);
    // @ts-expect-error — the variants mean different things: write caseOf(X, { about })
    reviewed.returns(oneOf(ChangesRequestedDto, DraftApprovedDto), { about: OfferDraftDto });
    // @ts-expect-error — a oneOf output is .returns(oneOf(…)), then .switch(…)
    reviewed.switch(
      caseOf(ChangesRequestedDto).toAgent(EditorAgent),
      caseOf(DraftApprovedDto).toAction(SendOfferAction),
    );
    // @ts-expect-error — after .returns(oneOf(…)) comes its .switch, not a transition
    reviewed.returns(oneOf(ChangesRequestedDto, DraftApprovedDto)).toAgent(EditorAgent);
    reviewed
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto, { about: OfferDraftDto }).toAgent(EditorAgent),
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
    expectTypeOf<InputOf<DraftHistoryWorkflowFinish>["drafts"]["previous"]>().toEqualTypeOf<
      readonly Produced<OfferDraftDto, typeof DraftEditorAgent | typeof FirstDraftAgent>[]
    >();
    expectTypeOf(historyOf(OfferDraftDto, { limit: 2 }).limit).toEqualTypeOf<number | undefined>();
  });

  it("a list start returns its list; a single producer one value", () => {
    start(CompanyBatchWorkflowStart).returns(listOf(CompanyDto));
    // @ts-expect-error — the start gives a list of CompanyDto
    start(CompanyBatchWorkflowStart).returns(CompanyDto);
    const drafted = start(CompanyCheckWorkflowStart)
      .returns(CompanyDto)
      .returns(optional(SearchRequestDto))
      .toAgent(CompanyCheckAgent);
    drafted.returns(CompanyScoreDto);
    // @ts-expect-error — company-check-agent gives one CompanyScoreDto
    drafted.returns(CompanyScoreDto).returns(CompanyDto);
    expectTypeOf<ProducerOutputOf<CompanyBatchWorkflowStart>>().toEqualTypeOf<
      readonly CompanyDto[]
    >();
  });
});

describe("S39: DTO brands tell two DTOs of the same shape apart", () => {
  it("a case for one of two same-shaped DTOs twice does not compile", () => {
    const verdict = agent(VerdictAgent).returns(oneOf(ApprovedVerdictDto, RejectedVerdictDto));
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
    expectTypeOf<DtoBrands["ApprovedVerdictDto"]>().toEqualTypeOf<ApprovedVerdictDto>();
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
    const input = {} as InputOf<SupportWorkflowFinish>;
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
    expectTypeOf<WorkflowStarts["company-check-workflow-start"]>().toEqualTypeOf<{
      input: { company: CompanyDto; request?: SearchRequestDto };
      output: CompanyScoreDto;
    }>();
    expectTypeOf<InputOf<CompanyCheckWorkflowStart>>().toEqualTypeOf<{
      company: CompanyDto;
      request?: SearchRequestDto;
    }>();
    expectTypeOf<OutputOf<SupportWorkflowFinish>>().not.toEqualTypeOf<ShortlistDto>();
  });
});
