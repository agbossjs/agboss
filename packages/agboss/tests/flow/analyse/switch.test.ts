import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
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
import { caseOf, start } from "../fixtures/paths.js";

/**
 * `.switch(caseOf(…)…)` is exhaustive over the `oneOf` it follows (#272 AC5), written after
 * `.returns(oneOf(…))` (#299 S54 c).
 */

const reviewed = () =>
  start(KitWorkflowStart)
    .returns(ShortlistDto)
    .toAgent(DraftKitAgent)
    .returns(OfferDraftDto)
    .toAgent(ReviewKitAgent);

const toReview = () => reviewed().returns(oneOf(ChangesRequestedDto, DraftApprovedDto));

const changes = () =>
  caseOf(ChangesRequestedDto)
    .toAgent(EditKitAgent)
    .returns(OfferDraftDto)
    .toFinish(DraftKitWorkflowFinish);

const approved = () =>
  caseOf(DraftApprovedDto)
    .toAction(SendKitAction)
    .returns(OfferSentDto)
    .toFinish(SentKitWorkflowFinish);

@Workflow({
  name: "exhaustive-workflow",
  version: "1.0.0",
  flow: [toReview().switch(approved(), changes())],
})
class ExhaustiveWorkflow {}

@Workflow({ name: "missing-case-workflow", version: "1.0.0", flow: [toReview().switch(changes())] })
class MissingCaseWorkflow {}

@Workflow({
  name: "unknown-case-workflow",
  version: "1.0.0",
  flow: [
    toReview().switch(changes(), approved(), caseOf(OfferSentDto).toFinish(SentKitWorkflowFinish)),
  ],
})
class UnknownCaseWorkflow {}

@Workflow({
  name: "switch-without-one-of-workflow",
  version: "1.0.0",
  flow: [
    start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .switch(caseOf(OfferDraftDto).toFinish(DraftKitWorkflowFinish)),
  ],
})
class SwitchWithoutOneOfWorkflow {}

@Workflow({
  name: "unreturned-one-of-workflow",
  version: "1.0.0",
  flow: [reviewed().switch(approved(), changes())],
})
class UnreturnedOneOfWorkflow {}

@Workflow({
  name: "wrong-one-of-workflow",
  version: "1.0.0",
  flow: [
    reviewed().returns(oneOf(ChangesRequestedDto, OfferSentDto)).switch(approved(), changes()),
  ],
})
class WrongOneOfWorkflow {}

@Workflow({
  name: "empty-case-workflow",
  version: "1.0.0",
  flow: [toReview().switch(changes(), caseOf(DraftApprovedDto))],
})
class EmptyCaseWorkflow {}

describe("AC5: exhaustive switch", () => {
  it("one case per variant passes, in any order", () => {
    expect(checkWorkflow(ExhaustiveWorkflow).errors).toEqual([]);
  });

  it("a missing variant fails, naming the case to add", () => {
    expect(checkWorkflow(MissingCaseWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "flow.switch-not-exhaustive",
        message:
          "missing-case-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto) — add caseOf(DraftApprovedDto)… to its switch",
      }),
    );
  });

  it("a class the step does not give fails", () => {
    expect(checkWorkflow(UnknownCaseWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "flow.switch-unknown-case",
        message:
          "unknown-case-workflow: caseOf(OfferSentDto): review-kit-agent does not give OfferSentDto — it gives oneOf(ChangesRequestedDto, DraftApprovedDto)",
      }),
    ]);
  });

  it("a switch after a step without a oneOf output fails", () => {
    expect(checkWorkflow(SwitchWithoutOneOfWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "flow.switch-unknown-case",
        message:
          "switch-without-one-of-workflow: draft-kit-agent gives OfferDraftDto, not a oneOf — .switch(caseOf(…)…) follows a step with a oneOf output; write .returns(…) after it instead",
      }),
    );
  });

  it("#299 S54 c: the oneOf is written before the switch, and is the step's output", () => {
    const mismatch = (workflow: abstract new () => unknown) =>
      checkWorkflow(workflow)
        .errors.filter((found) => found.code === "flow.returns-mismatch")
        .map((found) => found.message);

    expect(mismatch(UnreturnedOneOfWorkflow)).toEqual([
      "unreturned-one-of-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto) — write .returns(oneOf(ChangesRequestedDto, DraftApprovedDto)) before its .switch(…)",
    ]);
    expect(mismatch(WrongOneOfWorkflow)).toEqual([
      "wrong-one-of-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto) — write .returns(oneOf(ChangesRequestedDto, DraftApprovedDto)), not .returns(oneOf(ChangesRequestedDto, OfferSentDto))",
    ]);
  });

  it("a case that leads nowhere is a dead end", () => {
    expect(checkWorkflow(EmptyCaseWorkflow).errors).toEqual([
      expect.objectContaining({
        code: "graph.dead-end",
        message:
          "empty-case-workflow: review-kit-agent: caseOf(DraftApprovedDto) leads nowhere — continue it with .to…(…)",
      }),
    ]);
  });
});
