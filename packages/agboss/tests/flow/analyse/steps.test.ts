import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import { OfferDraftDto, OfferSentDto } from "../fixtures/dtos.js";
import {
  DraftKitWorkflowFinish,
  EditKitAgent,
  PolishKitAgent,
  SecondKitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { onStart, toFinish } from "../fixtures/paths.js";
import { supportPaths } from "../fixtures/support.fixture.js";

/** `maxSteps` bounds at assembly (#261 AC17): agent and router visits, only a hand-set value. */

const supportWith = (maxSteps?: number): abstract new () => unknown => {
  @Workflow({
    name: "support-steps-workflow",
    version: "1.0.0",
    flow: supportPaths,
    ...(maxSteps === undefined ? {} : { maxSteps }),
  })
  class SupportStepsWorkflow {}
  return SupportStepsWorkflow;
};

const actionsOnlyWith = (maxSteps: number): abstract new () => unknown => {
  @Workflow({
    name: "send-offer-workflow",
    version: "1.0.0",
    maxSteps,
    flow: [
      onStart(SecondKitWorkflowStart)
        .returns(OfferDraftDto)
        .toAction(SendKitAction)
        .returns(OfferSentDto)
        .toFinish(SentKitWorkflowFinish),
    ],
  })
  class SendOfferWorkflow {}
  return SendOfferWorkflow;
};

@Workflow({
  name: "steps-handler-workflow",
  version: "1.0.0",
  maxSteps: 1,
  flow: [
    onStart(SecondKitWorkflowStart)
      .returns(OfferDraftDto)
      .toAgent(EditKitAgent)
      .returns(OfferDraftDto)
      .toAgent(PolishKitAgent)
      .onError(LimitExceededError, toFinish(DraftKitWorkflowFinish))
      .returns(OfferDraftDto)
      .toFinish(DraftKitWorkflowFinish),
  ],
})
class StepsHandlerWorkflow {}

const errorsOf = (workflow: abstract new () => unknown) =>
  checkWorkflow(workflow).errors.map(({ code, message }) => ({ code, message }));

describe("#261 AC17: maxSteps bounds", () => {
  it("the default maxSteps never triggers a bound", () => {
    expect(errorsOf(supportWith())).toEqual([]);
  });

  it("maxSteps below the shortest way from a start to a finish fails", () => {
    expect(errorsOf(supportWith(1))).toEqual([
      {
        code: "limits.max-steps-too-low",
        message:
          "support-steps-workflow: the shortest path from support-workflow-start takes 3 steps, but maxSteps is 1",
      },
    ]);
  });

  it("a node every path through which is too long fails, while a shorter branch finishes", () => {
    expect(errorsOf(supportWith(3))).toEqual([
      {
        code: "limits.branch-exceeds-max-steps",
        message:
          "support-steps-workflow: every path through loyalty-agent takes at least 4 steps, but maxSteps is 3",
      },
    ]);
  });

  it("a path ending in a handler of the steps limit counts as reaching a finish", () => {
    expect(errorsOf(StepsHandlerWorkflow)).toEqual([]);
  });

  it.each([4, 0])("maxSteps: %i on a workflow with no agent or router fails", (maxSteps) => {
    expect(errorsOf(actionsOnlyWith(maxSteps))).toEqual([
      {
        code: "limits.max-steps-unused",
        message: `send-offer-workflow has maxSteps: ${String(maxSteps)}, but it has no agent or router — steps are always 0; remove maxSteps`,
      },
    ]);
  });
});
