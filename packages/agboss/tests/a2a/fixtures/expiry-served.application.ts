// #941 — the owner's question with a 10-minute deadline served over A2A: a task that waits for the
// caller's input, and expires.
import { A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  ExpiryLog,
  ExpiryPausedExecutionRepository,
  OwnerChannel,
  OwnerWorkflow,
  OwnerWorkflowStart,
} from "../../flow/fixtures/expiry.fixture.js";
import { RecordingLogger } from "../../helpers/log.js";
import { BearerCallerResolver } from "./bearer-caller-resolver.js";

@A2AExpose({
  name: "owner-a2a-expose",
  version: "1.0.0",
  description: "Orders their owner approves within 10 minutes",
  exports: [OwnerWorkflowStart],
})
export class OwnerA2AExpose {}

@Application({
  name: "expiry-served-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OwnerWorkflow],
  providers: [OwnerChannel, ExpiryPausedExecutionRepository, RecordingLogger, BearerCallerResolver],
  observers: [ExpiryLog],
  exposes: [OwnerA2AExpose],
  budgets: TEST_BUDGETS,
})
export class ExpiryServedApplication {}
