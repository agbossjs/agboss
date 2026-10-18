import { describe, expect, it } from "vitest";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  DraftKitWorkflowFinish,
  EditKitAgent,
  KitWorkflowStart,
  ReviewKitAgent,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { OrderWorkflow } from "../fixtures/order.fixture.js";
import { agent, caseOf, start } from "../fixtures/paths.js";

/** Where a node is continued (#272 AC3, AC4): inline from one place, own path from two or more. */

const reviewSwitch = () =>
  [
    caseOf(ChangesRequestedDto)
      .toAgent(EditKitAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewKitAgent),
    caseOf(DraftApprovedDto)
      .toAction(SendKitAction)
      .returns(OfferSentDto)
      .toFinish(SentKitWorkflowFinish),
  ] as const;

@Workflow({
  name: "inline-shared-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewKitAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(...reviewSwitch()),
  ],
})
class InlineSharedWorkflow {}

@Workflow({
  name: "own-path-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewKitAgent),
    agent(ReviewKitAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(...reviewSwitch()),
  ],
})
class OwnPathWorkflow {}

@Workflow({
  name: "single-entry-own-path-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart).returns(ShortlistDto).toAgent(DraftKitAgent),
    agent(DraftKitAgent).returns(OfferDraftDto).toFinish(DraftKitWorkflowFinish),
  ],
})
class SingleEntryOwnPathWorkflow {}

@Workflow({
  name: "continued-twice-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toFinish(DraftKitWorkflowFinish),
    agent(DraftKitAgent).returns(OfferDraftDto).toFinish(DraftKitWorkflowFinish),
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
          "inline-shared-workflow: review-kit-agent is reached from 2 paths — continue it in its own path agent(ReviewKitAgent)…",
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
          "single-entry-own-path-workflow: draft-kit-agent is reached from 1 path — continue it inline after .toAgent(DraftKitAgent) and remove its own path agent(DraftKitAgent)…",
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
