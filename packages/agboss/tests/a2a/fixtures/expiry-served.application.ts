// #941 — the owner's question with a 10-minute deadline served over A2A: a task that waits for the
// caller's input, and expires.
import { hours, minutes } from "../../../src/units/index.js";
import { A2AEndpoint } from "../../../src/a2a/a2a-endpoint.decorator.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  ExpiryLog,
  ExpiryPausedExecutionRepository,
  OwnerChannel,
  OwnerWorkflow,
  OwnerWorkflowStart,
} from "../../flow/fixtures/expiry.fixture.js";
import { RecordingLogger } from "../../helpers/log.js";
import { BearerAuthenticator } from "./bearer-authenticator.js";

@A2AEndpoint({
  name: "owner-a2a-expose",
  version: "1.0.0",
  description: "Orders their owner approves within 10 minutes",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [OwnerWorkflowStart],
})
export class OwnerA2AExpose {}

@Application({
  name: "expiry-served-application",
  version: "1.0.0",
  workflows: [OwnerWorkflow],
  providers: [OwnerChannel, ExpiryPausedExecutionRepository, RecordingLogger, BearerAuthenticator],
  observers: [ExpiryLog],
  endpoints: [OwnerA2AExpose],
  budgets: TEST_BUDGETS,
})
export class ExpiryServedApplication {}
