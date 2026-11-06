// #807 — the recovery workflow served over A2A: an application with an @A2AExpose, so the framework
// registers its A2A task projection.
import { A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  OrderWorkflowStart,
  RecoveryLog,
  RecoveryWorkflow,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";

@A2AExpose({ name: "orders-a2a-expose", version: "1.0.0", exports: [OrderWorkflowStart] })
export class OrdersA2AExpose {}

@Application({
  name: "orders-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  observers: [RecoveryLog],
  providers: [StampedExecutionRecordRepository],
  exposes: [OrdersA2AExpose],
  budgets: TEST_BUDGETS,
})
export class OrdersApplication {}

/** The same workflow with no A2A exposed: no projection. */
@Application({
  name: "orders-internal-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  providers: [StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class InternalOrdersApplication {}
