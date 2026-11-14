import { EmptyEnvironment } from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { WindowMemoryCheckpoints } from "../../../app/fixtures/writes-window.application.js";
import {
  ChildEventLog,
  ItemReviewWorkflow,
  ReviewOneWorkflow,
  ShopExecutionContext,
  ShopTenantContext,
} from "./children.workflow.js";
import { RecoveryLog } from "../../../infrastructure/fixtures/recovery.workflow.js";

/** #1090 — the single model child (an own-thread child that pauses) on the checkpoint saver whose `put` can be cut off. */
@Application({
  name: "children-window-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  tenantContext: ShopTenantContext,
  executionContext: ShopExecutionContext,
  workflows: [ReviewOneWorkflow, ItemReviewWorkflow],
  observers: [ChildEventLog, RecoveryLog],
  providers: [WindowMemoryCheckpoints],
  budgets: TEST_BUDGETS,
})
export class ChildrenWindowApplication {}
