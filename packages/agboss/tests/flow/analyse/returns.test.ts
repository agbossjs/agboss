import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  DraftKitWorkflowFinish,
  KitWorkflowStart,
  NotifyKitAction,
  ReviewKitAgent,
} from "../fixtures/kit.fixture.js";
import { start } from "../fixtures/paths.js";

/**
 * `.returns(…)` follows every step with an `output` and never one without (#272 AC2, AC15) — the
 * compiler checks it through the generated types, assembly checks it again (#270).
 */

const returnsErrorsOf = (...flow: Parameters<typeof Workflow>[0]["flow"]) => {
  @Workflow({ name: "returns-workflow", version: "1.0.0", flow })
  class ReturnsWorkflow {}
  return checkWorkflow(ReturnsWorkflow)
    .errors.filter((found) => found.code === "flow.returns-mismatch")
    .map((found) => found.message);
};

describe("AC15: .returns(…) is exactly where values are", () => {
  it("a missing .returns after a step with output fails", () => {
    const paths = start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .toFinish(DraftKitWorkflowFinish);

    expect(returnsErrorsOf(paths)).toEqual([
      "returns-workflow: draft-kit-agent gives OfferDraftDto — write .returns(OfferDraftDto) after it",
    ]);
  });

  it("a .returns of another class than the output fails", () => {
    const paths = start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(ShortlistDto)
      .toFinish(DraftKitWorkflowFinish);

    expect(returnsErrorsOf(paths)).toEqual([
      "returns-workflow: draft-kit-agent gives OfferDraftDto — write .returns(OfferDraftDto) after it, not .returns(ShortlistDto)",
    ]);
  });

  it("a .returns after an action without output fails", () => {
    const paths = start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAction(NotifyKitAction)
      .returns(OfferDraftDto)
      .toFinish(DraftKitWorkflowFinish);

    expect(returnsErrorsOf(paths)).toEqual([
      "returns-workflow: notify-kit-action has no output — remove .returns(OfferDraftDto) after it",
    ]);
  });

  it("AC2: start(S).returns(…) gives the start's input", () => {
    const paths = start(KitWorkflowStart).returns(OfferDraftDto).toFinish(DraftKitWorkflowFinish);

    expect(returnsErrorsOf(paths)).toEqual([
      "returns-workflow: kit-workflow-start gives ShortlistDto — write .returns(ShortlistDto) after it, not .returns(OfferDraftDto)",
    ]);
  });

  it("a oneOf output is written .returns(oneOf(…)) and branched by a switch", () => {
    const paths = start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewKitAgent)
      .returns(ChangesRequestedDto)
      .toFinish(DraftKitWorkflowFinish);

    expect(returnsErrorsOf(paths)).toEqual([
      "returns-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto) — write .returns(oneOf(ChangesRequestedDto, DraftApprovedDto)) and branch it with .switch(caseOf(…)…)",
    ]);
  });

  it("#299 S54 c: .returns(oneOf(…)) is followed by its .switch, never by a .to…", () => {
    const paths = start(KitWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftKitAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewKitAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .toFinish(DraftKitWorkflowFinish);

    expect(returnsErrorsOf(paths)).toEqual([
      "returns-workflow: review-kit-agent gives oneOf(ChangesRequestedDto, DraftApprovedDto) — write .returns(oneOf(ChangesRequestedDto, DraftApprovedDto)) and branch it with .switch(caseOf(…)…)",
      "returns-workflow: review-kit-agent: .returns(oneOf(ChangesRequestedDto, DraftApprovedDto)) is branched by .switch(caseOf(…)…), not followed by .toFinish(…)",
    ]);
  });
});
