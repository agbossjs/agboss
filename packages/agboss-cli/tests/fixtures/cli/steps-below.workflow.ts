// `agboss check --strict` fixture (#769): a loop every node of which maxVisits bounds — kit-router
// (maxVisits 3) ↔ edit-kit-agent (maxVisits 2), worst case 5 steps — with a hand-set maxSteps of 4:
// [limits.max-steps-below-worst-case] (#643), a warning, an error under --strict
// the untyped builder: this package has no generated types for the framework's fixtures
import { Application, Ttl } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import {
  onRouter,
  onStart,
  toAgent,
  toFinish,
} from "../../../../agboss/tests/flow/fixtures/paths.js";
import { Workflow } from "../../../../agboss/src/flow/decorators/workflow.js";
import { OfferDraftDto } from "../../../../agboss/tests/flow/fixtures/dtos.js";
import {
  DraftKitWorkflowFinish,
  EditKitAgent,
  KitRouter,
  SecondKitWorkflowStart,
} from "../../../../agboss/tests/flow/fixtures/kit.fixture.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

// the types import the DTO from a module the check loads
export { OfferDraftDto };

@Workflow({
  name: "steps-below-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 4 },
  flow: [
    onStart(SecondKitWorkflowStart)
      .toRouter(KitRouter),
    onRouter(KitRouter)
      .onRoute(
        toAgent(EditKitAgent)
          .toRouter(KitRouter),
      )
      .onRoute(toFinish(DraftKitWorkflowFinish)),
  ],
})
export class StepsBelowWorkflow {}

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  modelProvider: TestModelProvider,
  name: "steps-below-application",
  version: "1.0.0",
  workflows: [StepsBelowWorkflow],
  budgets: TEST_BUDGETS,
})
export class StepsBelowApplication {}
