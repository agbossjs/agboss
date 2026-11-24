import { describe, expect, it } from "vitest";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { ChangesRequestedDto, DraftApprovedDto } from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  DraftKitWorkflowFinish,
  EditKitAgent,
  KitWorkflowStart,
  ReviewKitAgent,
  SendKitAction,
  TakeApprovalKitAction,
  TakeChangesKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { OrderWorkflow } from "../fixtures/order.fixture.js";
import { onAgent, onStart, onWorkflow, toAgent, toAction, toFinish } from "../fixtures/paths.js";
import {
  CompanyGradeDto,
  CompanyRejectedDto,
  CompanyReviewFailedDto,
} from "../fixtures/child-dtos.js";
import {
  CompanyPickerAgent,
  CompanyReviewWorkflow,
  JobOfferAgent,
  JobOfferWorkflowFinish,
  LinkOfferWorkflow,
  LinkOfferWorkflowStart,
  NoOfferFailedWorkflowFinish,
  NoOfferRejectedWorkflowFinish,
  PickedOfferWorkflowStart,
} from "../fixtures/children.fixture.js";

/** Where a node is continued (#272 AC3, AC4): inline from one place, own path from two or more. */

const reviewSwitch = () =>
  [
    toAction(TakeChangesKitAction).toAgent(EditKitAgent).toAgent(ReviewKitAgent),
    toAction(TakeApprovalKitAction).toAction(SendKitAction).toFinish(SentKitWorkflowFinish),
  ] as const;

@Workflow({
  name: "inline-shared-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart)
      .toAgent(DraftKitAgent)
      .toAgent(ReviewKitAgent)
      .toOneOf(reviewSwitch()),
  ],
})
class InlineSharedWorkflow {}

@Workflow({
  name: "own-path-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart).toAgent(DraftKitAgent).toAgent(ReviewKitAgent),
    onAgent(ReviewKitAgent).toOneOf(reviewSwitch()),
  ],
})
class OwnPathWorkflow {}

@Workflow({
  name: "single-entry-own-path-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart).toAgent(DraftKitAgent),
    onAgent(DraftKitAgent).toFinish(DraftKitWorkflowFinish),
  ],
})
class SingleEntryOwnPathWorkflow {}

@Workflow({
  name: "continued-twice-workflow",
  version: "1.0.0",
  flow: [
    onStart(KitWorkflowStart).toAgent(DraftKitAgent).toFinish(DraftKitWorkflowFinish),
    onAgent(DraftKitAgent).toFinish(DraftKitWorkflowFinish),
  ],
})
class ContinuedTwiceWorkflow {}

const errorsOf = (workflow: abstract new () => unknown) =>
  checkWorkflow(workflow).errors.map(({ code, message }) => ({ code, message }));

describe("AC3: one way in → inline, two or more → own path", () => {
  it("shared node inline: names the node and the own path to write", () => {
    expect(errorsOf(InlineSharedWorkflow)).toEqual([
      {
        code: "flow.shared-node-inline",
        message:
          "inline-shared-workflow: review-kit-agent is reached from 2 paths — continue it in its own path onAgent(ReviewKitAgent)…",
      },
    ]);
  });

  it("a shared node continued in its own path passes", () => {
    expect(errorsOf(OwnPathWorkflow)).toEqual([]);
  });

  it("single entry own path: says to continue it inline", () => {
    expect(errorsOf(SingleEntryOwnPathWorkflow)).toEqual([
      {
        code: "flow.single-entry-own-path",
        message:
          "single-entry-own-path-workflow: draft-kit-agent is reached from 1 path — continue it inline after .toAgent(DraftKitAgent) and remove its own path onAgent(DraftKitAgent)…",
      },
    ]);
  });

  it("a finish is inline from any number of places", () => {
    expect(errorsOf(OrderWorkflow)).toEqual([]);
  });
});

describe("AC4: one class is one node", () => {
  it("continuation twice: tells to make a second class from shared options", () => {
    expect(errorsOf(ContinuedTwiceWorkflow)).toEqual([
      {
        code: "flow.continuation-twice",
        message:
          'continued-twice-workflow: draft-kit-agent is continued in 2 places — one class is one node; make a second class (…options, name: "…")',
      },
    ]);
  });
});

describe("#263 AC4: child inline / own path", () => {
  const REVIEWED = oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto);
  const reviewCases = () =>
    [
      toAgent(JobOfferAgent).toFinish(JobOfferWorkflowFinish),
      toFinish(NoOfferRejectedWorkflowFinish),
      toFinish(NoOfferFailedWorkflowFinish),
    ] as const;
  const picked = () => onStart(PickedOfferWorkflowStart).toAgent(CompanyPickerAgent);
  const linked = () => onStart(LinkOfferWorkflowStart);

  @Workflow({
    name: "child-single-own-path-workflow",
    version: "1.0.0",
    flow: [
      picked().toWorkflow(CompanyReviewWorkflow),
      onWorkflow(CompanyReviewWorkflow).toOneOf(reviewCases()),
    ],
  })
  class ChildSingleOwnPathWorkflow {}

  @Workflow({
    name: "child-shared-inline-workflow",
    version: "1.0.0",
    flow: [
      picked().toWorkflow(CompanyReviewWorkflow).toOneOf(reviewCases()),
      linked().toWorkflow(CompanyReviewWorkflow),
    ],
  })
  class ChildSharedInlineWorkflow {}

  it("child inline / own path: one way in → inline, reached from 1 path in its own path fails", () => {
    expect(errorsOf(ChildSingleOwnPathWorkflow)).toEqual([
      {
        code: "flow.single-entry-own-path",
        message:
          "child-single-own-path-workflow: company-review-workflow is reached from 1 path — continue it inline after .toWorkflow(CompanyReviewWorkflow) and remove its own path onWorkflow(CompanyReviewWorkflow)…",
      },
    ]);
  });

  it("child inline / own path: two ways in continued inline fails; its own path passes", () => {
    expect(errorsOf(ChildSharedInlineWorkflow)).toContainEqual({
      code: "flow.shared-node-inline",
      message:
        "child-shared-inline-workflow: company-review-workflow is reached from 2 paths — continue it in its own path onWorkflow(CompanyReviewWorkflow)…",
    });
    expect(errorsOf(LinkOfferWorkflow)).toEqual([]);
  });
});
