import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  DeskRefundChannel,
  InboxSpendingLimitChannel,
  PurchaseTargetsWorkflow,
  RefundTargetsWorkflow,
} from "../../../channels/pause-targets.fixture.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/** The pause targets of the channels' fixture, under profiles: how long their pauses wait. */
@Application({
  name: "pause-shelves-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [PurchaseTargetsWorkflow, RefundTargetsWorkflow],
  budgets: TEST_BUDGETS,
  channels: [InboxSpendingLimitChannel, DeskRefundChannel],
})
export class PauseShelvesApplication {}
