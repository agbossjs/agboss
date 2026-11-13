/** The guarded agents (#1006) served over A2A: what a client's socket receives of a blocked answer. */
import { A2AExpose, A2ACallerResolution, type A2ACallerResolver } from "../../src/a2a/index.js";
import { Injectable } from "../../src/components/decorators.js";
import { EmptyEnvironment, Workflow, WorkflowFinish, WorkflowStart } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { GuardedAgent } from "./guarded.fixture.js";

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

@Injectable()
export class WireCallerResolver implements A2ACallerResolver<typeof WireGuardedStart> {
  resolveCaller(): A2ACallerResolution<typeof WireGuardedStart> {
    return A2ACallerResolution.resolved({});
  }
}

@Workflow({
  name: "wire-guarded-workflow",
  version: "1.0.0",
  flow: [
    start(WireGuardedStart)
      .returns(WorkflowStartTextDto)
      .toAgent(GuardedAgent)
      .toFinish(WireGuardedFinish),
  ],
  defaults: DEFAULTS,
  providers: [WireCallerResolver],
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
  exposes: [WireA2AExpose],
})
export class WireApplication {}

export const wireListener = { expose: WireA2AExpose, callerResolver: WireCallerResolver };
