import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { SingleChildWorkflow } from "../../channels/fixtures/child-pauses.workflow.js";
import {
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  AutoRefundChannel,
  PauseLog,
  SeenPausedExecutionRepository,
} from "../../channels/fixtures/pauses.workflow.js";
import { CountdownWorkflow } from "../../flow/runtime/fixtures/recursion.workflow.js";
import { RemoteCountdownWorkflow } from "../../flow/runtime/fixtures/remote-recursion.workflow.js";
import { PlannedIdGenerator } from "./minted-ids.application.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #591 — the planned ids of #578 on a root with a pausing child, a recursion on this instance and
 * one on any instance: what a generator that repeats an execution id meets at each kind of
 * execution it mints for.
 */
@Application({
  name: "repeated-ids-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [SingleChildWorkflow, CountdownWorkflow, RemoteCountdownWorkflow],
  providers: [
    PlannedIdGenerator,
    FinanceDeskRefundApprovalChannel,
    AutoRefundChannel,
    CustomerOrderConfirmationChannel,
    SeenPausedExecutionRepository,
  ],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class RepeatedIdsApplication {}
