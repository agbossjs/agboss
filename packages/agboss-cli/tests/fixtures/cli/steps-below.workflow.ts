// `agboss check --strict` fixture (#769): a loop every node of which maxVisits bounds — kit-router
// (maxVisits 3) ↔ edit-kit-agent (maxVisits 2), worst case 5 steps — with a hand-set maxSteps of 4:
// [limits.max-steps-below-worst-case] (#643), a warning, an error under --strict
// the untyped builder: this package has no generated types for the framework's fixtures
import { Application, EmptyEnvironment } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { route, router, start } from "../../../../agboss/tests/flow/fixtures/paths.js";
import { Workflow } from "../../../../agboss/src/flow/decorators/workflow.js";
import { OfferDraftDto } from "../../../../agboss/tests/flow/fixtures/dtos.js";
import {
  DraftKitWorkflowFinish,
  EditKitAgent,
  KitRouter,
  SecondKitWorkflowStart,
} from "../../../../agboss/tests/flow/fixtures/kit.fixture.js";

// the types import the DTO from a module the check loads
export { OfferDraftDto };

@Workflow({
  name: "steps-below-workflow",
  version: "1.0.0",
  maxSteps: 4,
  flow: [
    start(SecondKitWorkflowStart)
      .returns(OfferDraftDto)
      .toRouter(KitRouter),
    router(KitRouter)
      .chooseOne(
        route(EditKitAgent)
          .returns(OfferDraftDto)
          .toRouter(KitRouter),
        route(DraftKitWorkflowFinish),
      ),
  ],
})
export class StepsBelowWorkflow {}

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  name: "steps-below-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [StepsBelowWorkflow],
  budgets: TEST_BUDGETS,
})
export class StepsBelowApplication {}
