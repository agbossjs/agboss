import { EmptyEnvironment } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { YieldLog, YieldOneWorkflow } from "./remote-child-yield.workflow.js";

/** #928 — the child queue with hold points: a claim's answer can be held for ever (never released). */
export const HeldQueue = withHoldPoints(InMemoryChildExecutionQueueRepository);

/** The #720 application (a parent and its `AnyInstance` child) on a queue whose answers can be held. */
@Application({
  name: "lost-answer-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [YieldOneWorkflow],
  observers: [YieldLog],
  providers: [HeldQueue, RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class LostAnswerApplication {}
