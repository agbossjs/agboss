import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { start as publicStart, toQuestion as publicToQuestion } from "../../../src/flow/builder.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import { hours } from "../../../src/units/index.js";
import { RecordingLogger } from "../../helpers/log.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  DirectorChannel,
  DirectorQuestion,
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryLog,
  ExpiryOrderDto,
  ExpiryPausedExecutionRepository,
  ExpiryWorkflowFinish,
  ManagerChannel,
  ManagerQuestion,
  RecordEscalatedAction,
  RecordExpiryAction,
} from "./expiry.fixture.js";

/**
 * #941 (the scope note of #933's acceptance) — `.toQuestion(Manager, { expiresIn })` and the side
 * path `toQuestion(Director, { expiresIn })`, written with the SHIPPED starters of `builder.ts`:
 * the manager's pause expires, the director is asked (with a deadline of its own), the answer goes
 * on the path.
 */

@WorkflowStart({
  name: "public-expiry-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
export class PublicExpiryWorkflowStart {}

@Workflow({
  name: "public-expiry-workflow",
  version: "1.0.0",
  flow: [
    publicStart(PublicExpiryWorkflowStart)
      .returns(ExpiryOrderDto)
      .toQuestion(ManagerQuestion, { expiresIn: hours(4) })
      .onError(
        PauseExpiredError,
        publicToQuestion(DirectorQuestion, { expiresIn: hours(1) })
          .returns(ExpiryDecisionDto)
          .toAction(RecordEscalatedAction)
          .returns(ExpiryDoneDto)
          .toFinish(ExpiryWorkflowFinish),
      )
      .returns(ExpiryDecisionDto)
      .toAction(RecordExpiryAction)
      .returns(ExpiryDoneDto)
      .toFinish(ExpiryWorkflowFinish),
  ],
})
export class PublicExpiryWorkflow {}

@Application({
  name: "public-expiry-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PublicExpiryWorkflow],
  budgets: TEST_BUDGETS,
  providers: [ManagerChannel, DirectorChannel, ExpiryPausedExecutionRepository, RecordingLogger],
  observers: [ExpiryLog],
})
export class PublicExpiryApplication {}
