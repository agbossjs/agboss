import { describe, expect, it } from "vitest";
import {
  analyseWorkflow,
  checkWorkflow,
  inputShapesOf,
} from "../../../src/flow/analyse/analyse.js";
import { MAX_SCOPES_PER_NODE } from "../../../src/flow/analyse/dataflow.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import { Action } from "../../../src/flow/decorators/action.js";
import {
  ExpertDraftDto,
  FastDraftDto,
  LoyaltyOfferDto,
  OrderStatusDto,
} from "../fixtures/data-dtos.js";
import {
  OfferDraftDto,
  OfferSentDto,
  ProfileDto,
  ResumeMissingDto,
  ReviewDto,
  ShortlistDto,
  WorkflowStartTextDto,
} from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  EditKitAgent,
  KitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { OfferWorkflow } from "../fixtures/offer.fixture.js";
import { agent, returnsEach, route, start } from "../fixtures/paths.js";
import {
  FastAnswerAgent,
  LoyaltyAgent,
  OrderAgent,
  SupportWorkflow,
  SupportWorkflowFinish,
  SupportWorkflowStart,
} from "../fixtures/support.fixture.js";

/** The path scope (#270 AC4) on the data-flow engine (#272 S10). */

@Workflow({
  name: "overwrite-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(EditKitAgent)
      .returns(OfferDraftDto)
      .toAction(SendKitAction)
      .returns(OfferSentDto)
      .toFinish(SentKitWorkflowFinish),
  ],
})
class OverwriteWorkflow {}

@Agent({
  name: "drafts-kit-agent",
  description: "Drafts several offers",
  prompt: "Draft them.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: listOf(OfferDraftDto),
})
class DraftsKitAgent {}

@Workflow({
  name: "list-is-not-single-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftsKitAgent)
      .returns(listOf(OfferDraftDto))
      .toAction(SendKitAction)
      .returns(OfferSentDto)
      .toFinish(SentKitWorkflowFinish),
  ],
})
class ListIsNotSingleWorkflow {}

@Agent({
  name: "strict-expert-agent",
  description: "Needs a loyalty offer on every path",
  prompt: "Reply carefully.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
    loyalty: LoyaltyOfferDto,
  },
  output: ExpertDraftDto,
})
class StrictExpertAgent {}

@Router({
  name: "strict-router",
  description: "Picks how to answer",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  input: {
    order: OrderStatusDto,
  },
  routes: [
    { target: FastAnswerAgent, prompt: "A simple question, double-checked" },
    { target: LoyaltyAgent, prompt: "A loyal customer" },
    { target: StrictExpertAgent, prompt: "A hard question" },
  ],
})
class StrictRouter {}

@Workflow({
  name: "witness-workflow",
  version: "1.0.0",
  flow: [
    start(SupportWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OrderAgent)
      .returns(OrderStatusDto)
      .toRouter(StrictRouter)
      .chooseOne(
        route(FastAnswerAgent).returns(FastDraftDto).toAgent(StrictExpertAgent),
        route(LoyaltyAgent).returns(LoyaltyOfferDto).toAgent(StrictExpertAgent),
        route(StrictExpertAgent),
      ),
    agent(StrictExpertAgent).returns(ExpertDraftDto).toFinish(SupportWorkflowFinish),
  ],
})
class WitnessWorkflow {}

@WorkflowStart({
  name: "contract-workflow-start",
  description: "Two reviews of one class",
  input: {
    legal: ReviewDto,
    compliance: ReviewDto,
  },
})
class ContractWorkflowStart {}

@Agent({
  name: "contract-summary-agent",
  description: "Sums the review up",
  prompt: "Sum up.",
  model: "moonshotai/kimi-k2.6",
  input: {
    review: ReviewDto,
  },
  output: ShortlistDto,
})
class ContractSummaryAgent {}

@WorkflowFinish({
  name: "contract-workflow-finish",
  description: "The summary",
  output: ShortlistDto,
})
class ContractWorkflowFinish {}

@Workflow({
  name: "contract-workflow",
  version: "1.0.0",
  flow: [
    start(ContractWorkflowStart)
      .returns(ReviewDto)
      .returns(ReviewDto)
      .toAgent(ContractSummaryAgent)
      .returns(ShortlistDto)
      .toFinish(ContractWorkflowFinish),
  ],
})
class ContractWorkflow {}

/** 13 optional fields of a start: 2^13 = 8192 reachable scopes at the next node. */
const manyDtos = Array.from({ length: 13 }, (_, index) => {
  const name = `Field${String(index + 1)}Dto`;
  return {
    [name]: class {
      value!: string;
    },
  }[name];
}).filter((dto) => dto !== undefined);

@WorkflowStart({
  name: "wide-workflow-start",
  description: "Many optional fields",
  input: Object.fromEntries(
    manyDtos.map((dto, index) => [`field${String(index + 1)}`, optional(dto)]),
  ),
})
class WideWorkflowStart {}

@WorkflowFinish({
  name: "wide-workflow-finish",
  description: "Reads them all",
  input: Object.fromEntries(
    manyDtos.map((dto, index) => [`field${String(index + 1)}`, optional(dto)]),
  ),
  output: ShortlistDto,
})
class WideWorkflowFinish {
  finish(): ShortlistDto {
    return { candidates: "" };
  }
}

@Workflow({
  name: "wide-workflow",
  version: "1.0.0",
  flow: [
    returnsEach(start(WideWorkflowStart), manyDtos.map(optional)).toFinish(WideWorkflowFinish),
  ],
})
class WideWorkflow {}

@Agent({
  name: "screen-agent",
  description: "Screens each candidate",
  prompt: "Screen them.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: listOf(oneOf(ProfileDto, ResumeMissingDto)),
})
class ScreenAgent {}

@Action({
  name: "file-profiles-action",
  description: "Files the profiles found",
  input: {
    results: listOf(oneOf(ResumeMissingDto, ProfileDto)),
  },
})
class FileProfilesAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

/** Reads the profiles alone: a mixed list is never filtered into one (#299 S53). */
@Action({
  name: "file-only-profiles-action",
  description: "Files only the profiles",
  input: {
    profiles: listOf(ProfileDto),
  },
})
class FileOnlyProfilesAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@WorkflowFinish({
  name: "screened-workflow-finish",
  description: "The shortlist, screened",
  output: ShortlistDto,
})
class ScreenedWorkflowFinish {}

@Workflow({
  name: "screen-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(ScreenAgent)
      .returns(listOf(oneOf(ProfileDto, ResumeMissingDto)))
      .toAction(FileProfilesAction)
      .toFinish(ScreenedWorkflowFinish),
  ],
})
class ScreenWorkflow {}

@Workflow({
  name: "filtered-screen-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(ScreenAgent)
      .returns(listOf(oneOf(ProfileDto, ResumeMissingDto)))
      .toAction(FileOnlyProfilesAction)
      .toFinish(ScreenedWorkflowFinish),
  ],
})
class FilteredScreenWorkflow {}

const present = (name: string, producer: string) => ({
  name,
  isPresent: true,
  producers: [producer],
});
const absent = (name: string) => ({ name, isPresent: false, producers: [] });

describe("#270 AC4: the path scope", () => {
  it("latest on the path: a single field takes the newest value of its type", () => {
    expect(inputShapesOf(analyseWorkflow(OverwriteWorkflow), "send-kit-action")).toEqual([
      [present("draft", "edit-kit-agent")],
    ]);
  });

  it("latest on the path in a loop: the reviewer gets the first draft or the latest edit", () => {
    expect(inputShapesOf(analyseWorkflow(OfferWorkflow), "reviewer-agent")).toEqual([
      [present("draft", "draft-agent")],
      [present("draft", "editor-agent")],
    ]);
  });

  it("an optional field is present on one path into a node and absent on another", () => {
    expect(inputShapesOf(analyseWorkflow(SupportWorkflow), "expert-answer-agent")).toEqual([
      [
        present("message", "support-workflow-start"),
        present("order", "order-agent"),
        absent("loyalty"),
      ],
      [
        present("message", "support-workflow-start"),
        present("order", "order-agent"),
        present("loyalty", "loyalty-agent"),
      ],
    ]);
  });

  it("exact shapes: a list never fills a single field", () => {
    expect(checkWorkflow(ListIsNotSingleWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "input.missing-on-path",
        message:
          "list-is-not-single-workflow: send-kit-action.draft (OfferDraftDto) is not produced on the path kit-workflow-start → drafts-kit-agent → send-kit-action",
      }),
    );
  });

  it("#299 AC1 (S53): a listOf(oneOf(…)) reaches a field of the whole list, in any order of classes", () => {
    expect(inputShapesOf(analyseWorkflow(ScreenWorkflow), "file-profiles-action")).toEqual([
      [present("results", "screen-agent")],
    ]);
  });

  it("#299 AC1 (S53): it never fills a listOf(one class) — no filtered slot", () => {
    expect(checkWorkflow(FilteredScreenWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "input.missing-on-path",
        message:
          "filtered-screen-workflow: file-only-profiles-action.profiles (listOf(ProfileDto)) is not produced on the path kit-workflow-start → screen-agent → file-only-profiles-action",
      }),
    );
  });

  it("several values of one class at once fail a single field", () => {
    expect(checkWorkflow(ContractWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "input.several-on-path",
        message:
          "contract-workflow: contract-summary-agent.review (ReviewDto): contract-workflow-start brings 2 values on the path contract-workflow-start → contract-summary-agent — declare listOf(ReviewDto), or give the values different classes",
      }),
    ]);
  });
});

describe("#270 AC4, #272 S10: one engine over sets of abstract scopes", () => {
  it("field correlation is kept: the finish gets { fast } or { expert }, never neither", () => {
    expect(inputShapesOf(analyseWorkflow(SupportWorkflow), "support-workflow-finish")).toEqual([
      [absent("fast"), present("expert", "expert-answer-agent")],
      [present("fast", "fast-answer-agent"), absent("expert")],
    ]);
  });

  it("witness paths are the shortest", () => {
    expect(checkWorkflow(WitnessWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "input.missing-on-path",
        message:
          "witness-workflow: strict-expert-agent.loyalty (LoyaltyOfferDto) is not produced on the path support-workflow-start → order-agent → strict-router → strict-expert-agent",
      }),
    ]);
  });

  it(`more than ${String(MAX_SCOPES_PER_NODE)} scopes at one node fail, naming the slots`, () => {
    const slots = manyDtos
      .map((dto) => dto.name)
      .sort()
      .join(", ");

    expect(checkWorkflow(WideWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "flow.analysis-too-large",
        message: `wide-workflow: wide-workflow-finish is reached with more than 4096 path scopes — the slots ${slots} multiply them; move a branch into a child workflow (agboss generate workflow …)`,
      }),
    ]);
  });
});
