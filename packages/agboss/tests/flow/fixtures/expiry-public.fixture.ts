import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import {
  onStart as publicStart,
  toExternalTask as publicToQuestion,
} from "../../../src/flow/builder.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import { RecordingLogger } from "../../helpers/log.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  HourDirectorChannel,
  HourDirectorExternalTask,
  ExpiryLog,
  ExpiryOrderDto,
  ExpiryPausedExecutionRepository,
  ExpiryWorkflowFinish,
  ShortManagerChannel,
  ShortManagerExternalTask,
  RecordEscalatedAction,
  RecordExpiryAction,
} from "./expiry.fixture.js";

/**
 * #941 (the scope note of #933's acceptance) — `.toExternalTask(Manager)` and the side
 * path `toExternalTask(Director)`, written with the SHIPPED starters of `builder.ts`:
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
      .toExternalTask(ShortManagerExternalTask)
      .onError(
        PauseExpiredError,
        publicToQuestion(HourDirectorExternalTask)
          .toAction(RecordEscalatedAction)
          .toFinish(ExpiryWorkflowFinish),
      )
      .toAction(RecordExpiryAction)
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
  providers: [
    ShortManagerChannel,
    HourDirectorChannel,
    ExpiryPausedExecutionRepository,
    RecordingLogger,
  ],
  observers: [ExpiryLog],
})
export class PublicExpiryApplication {}
