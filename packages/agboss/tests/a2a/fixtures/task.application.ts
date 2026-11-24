// #807 — the recovery workflow served over A2A: an application with an @A2AEndpoint, so the framework
// registers its A2A task projection.
import { hours, minutes } from "../../../src/units/index.js";
import { A2AEndpoint } from "../../../src/a2a/a2a-endpoint.decorator.js";
import { BearerAuthenticator } from "./bearer-authenticator.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  OrderWorkflowStart,
  RecoveryLog,
  RecoveryWorkflow,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";

@A2AEndpoint({
  name: "orders-a2a-expose",
  version: "1.0.0",
  description: "Takes orders: steps, holds and charges",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [OrderWorkflowStart],
})
export class OrdersA2AExpose {}

@Application({
  name: "orders-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryWorkflow],
  observers: [RecoveryLog],
  providers: [StampedExecutionRecordRepository, BearerAuthenticator],
  endpoints: [OrdersA2AExpose],
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
