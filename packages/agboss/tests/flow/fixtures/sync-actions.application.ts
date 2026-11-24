import { Application } from "../../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { EmptyEnvironment, type Produced } from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "./budgets.js";

/** Pure data mapping: sync, no promise, no `implements`. */
@Action({
  name: "shout-action",
  description: "Upper-cases the text",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
export class ShoutAction {
  execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): WorkflowFinishTextDto {
    return { text: input.message.value.text.toUpperCase() };
  }
}

/** Throws synchronously. */
@Action({
  name: "sync-throw-action",
  description: "Throws before it returns",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
export class SyncThrowAction {
  execute(): WorkflowFinishTextDto {
    throw new Error("sync boom");
  }
}

/** Never returns, with a timeout. */
@Action({
  name: "hanging-action",
  description: "Hangs on a socket",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  timeout: seconds(5),
})
export class HangingAction {
  execute(): Promise<WorkflowFinishTextDto> {
    return new Promise(() => undefined);
  }
}

@WorkflowStart({ name: "sync-workflow-start", description: "A text", input: WorkflowStartTextDto })
export class SyncStart {}

@WorkflowStart({
  name: "constant-workflow-start",
  description: "A text",
  input: WorkflowStartTextDto,
})
export class ConstantStart {}

@WorkflowStart({ name: "throw-workflow-start", description: "A text", input: WorkflowStartTextDto })
export class ThrowStart {}

@WorkflowStart({ name: "hang-workflow-start", description: "A text", input: WorkflowStartTextDto })
export class HangStart {}

@WorkflowFinish({
  name: "sync-workflow-finish",
  description: "The text",
  output: WorkflowFinishTextDto,
})
export class SyncFinish {}

@Workflow({
  name: "sync-workflow",
  version: "1.0.0",
  flow: [
    onStart(SyncStart).toAction(ShoutAction).toFinish(SyncFinish),
    onStart(ThrowStart).toAction(SyncThrowAction).toFinish(SyncFinish),
    onStart(HangStart).toAction(HangingAction).toFinish(SyncFinish),
  ],
})
export class SyncWorkflow {}

@Application({
  name: "sync-actions-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SyncWorkflow],
  budgets: TEST_BUDGETS,
})
export class SyncActionsApplication {}
