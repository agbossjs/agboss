import { Application } from "../../../../src/application/application.js";
import { ChatWorkflow } from "../../../flow/fixtures/chat.fixture.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";

/** The application of `solo/solo.workflow.ts`, one folder above it. */
@Application({
  name: "solo-application",
  version: "1.0.0",
  workflows: [ChatWorkflow],
  budgets: TEST_BUDGETS,
})
export class SoloApplication {}
