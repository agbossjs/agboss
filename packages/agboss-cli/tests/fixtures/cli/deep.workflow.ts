// `agboss check --strict` fixture (#263): a path nested past four levels — a warning, an error
// under --strict ([flow.path-too-deep])
import { start, toAction } from "../../../../agboss/src/flow/builder.js";
import { Action } from "../../../../agboss/src/flow/decorators/action.js";
import { Workflow } from "../../../../agboss/src/flow/decorators/workflow.js";
import { OfferDraftDto } from "../../../../agboss/tests/flow/fixtures/dtos.js";
import {
  DraftKitWorkflowFinish,
  EditKitAgent,
  SecondKitWorkflowStart,
} from "../../../../agboss/tests/flow/fixtures/kit.fixture.js";

// the types import the DTO from a module the check loads
export { OfferDraftDto };

class DeliveryError extends Error {}

@Action({ name: "deep-first-action", description: "Level 1" })
export class DeepFirstAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-second-action", description: "Level 2" })
export class DeepSecondAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-third-action", description: "Level 3" })
export class DeepThirdAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-fourth-action", description: "Level 4" })
export class DeepFourthAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({ name: "deep-fifth-action", description: "Level 5" })
export class DeepFifthAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Workflow({
  name: "deep-workflow",
  version: "1.0.0",
  flow: [
    start(SecondKitWorkflowStart)
      .returns(OfferDraftDto)
      .toAgent(EditKitAgent)
      .onError(
        DeliveryError,
        toAction(DeepFirstAction)
          .onError(
            DeliveryError,
            toAction(DeepSecondAction)
              .onError(
                DeliveryError,
                toAction(DeepThirdAction)
                  .onError(
                    DeliveryError,
                    toAction(DeepFourthAction)
                      .onError(
                        DeliveryError,
                        toAction(DeepFifthAction)
                          .toFinish(DraftKitWorkflowFinish),
                      )
                      .toFinish(DraftKitWorkflowFinish),
                  )
                  .toFinish(DraftKitWorkflowFinish),
              )
              .toFinish(DraftKitWorkflowFinish),
          )
          .toFinish(DraftKitWorkflowFinish),
      )
      .returns(OfferDraftDto)
      .toFinish(DraftKitWorkflowFinish),
  ],
})
export class DeepWorkflow {}
