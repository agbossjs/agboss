/** The guarded agents (#1006) served over A2A: what a client's socket receives of a blocked answer. */
import { A2AExpose } from "../../src/a2a/index.js";
import { Injectable } from "../../src/components/decorators.js";
import { EmptyEnvironment, Workflow, WorkflowFinish, WorkflowStart } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { GuardedAgent } from "./guarded.fixture.js";
import { HttpAuthResult, HttpAuthenticator } from "../../src/index.js";

@WorkflowStart({
  name: "wire-guarded-workflow-start",
  description: "Q",
  input: WorkflowStartTextDto,
})
class WireGuardedStart {}

@WorkflowFinish({
  name: "wire-guarded-workflow-finish",
  description: "A",
  output: WorkflowFinishTextDto,
})
class WireGuardedFinish {}

@HttpAuthenticator()
export class WireAuthenticator {
  authenticate(): HttpAuthResult {
    return HttpAuthResult.authenticated({});
  }
}

@Workflow({
  name: "wire-guarded-workflow",
  version: "1.0.0",
  flow: [onStart(WireGuardedStart).toAgent(GuardedAgent).toFinish(WireGuardedFinish)],
  defaults: DEFAULTS,
  providers: [WireAuthenticator],
})
class WireGuardedWorkflow {}

@A2AExpose({
  name: "wire-guarded-a2a-expose",
  description: "Served",
  version: "1.0.0",
  exports: [WireGuardedStart],
})
export class WireA2AExpose {}

@Application({
  name: "wire-guarded-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [WireGuardedWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
  endpoints: [WireA2AExpose],
})
export class WireApplication {}

export const wireListener = { endpoint: WireA2AExpose, authenticator: WireAuthenticator };
