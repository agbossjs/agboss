import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
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
import { caseOf, onStart } from "../fixtures/paths.js";

/**
 * `.switch(caseOf(…)…)` is exhaustive over the `oneOf` output of the step it follows (#272 AC5,
 * #299 S54 c).
 */

const reviewed = () => onStart(KitWorkflowStart).toAgent(DraftKitAgent).toAgent(ReviewKitAgent);

const toReview = () => reviewed();

const changes = () =>
  caseOf(ChangesRequestedDto).toAgent(EditKitAgent).toFinish(DraftKitWorkflowFinish);

const approved = () =>
  caseOf(DraftApprovedDto).toAction(SendKitAction).toFinish(SentKitWorkflowFinish);

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
    onStart(KitWorkflowStart)
      .toAgent(DraftKitAgent)
      .switch(caseOf(OfferDraftDto).toFinish(DraftKitWorkflowFinish)),
  ],
})
class SwitchWithoutOneOfWorkflow {}

@Workflow({
  name: "unswitched-one-of-workflow",
  version: "1.0.0",
  flow: [reviewed().toAction(SendKitAction).toFinish(SentKitWorkflowFinish)],
})
class UnswitchedOneOfWorkflow {}

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
          "switch-without-one-of-workflow: draft-kit-agent gives OfferDraftDto, not a oneOf — .switch(caseOf(…)…) follows a step with a oneOf output; continue with .to…(…) after it instead",
      }),
    );
  });

  it("a transition right after a oneOf output, without the switch, fails", () => {
    expect(checkWorkflow(UnswitchedOneOfWorkflow).errors).toContainEqual(
      expect.objectContaining({
        code: "flow.switch-not-exhaustive",
        message:
          "unswitched-one-of-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto) — branch it with .switch(caseOf(…)…)",
      }),
    );
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
