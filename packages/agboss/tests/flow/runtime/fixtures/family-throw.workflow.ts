import { A2AError } from "../../../../src/core/error-families/a2a-errors.js";
import { ConfigError } from "../../../../src/core/error-families/config-errors.js";
import { StoreError } from "../../../../src/core/error-families/store-errors.js";
import { StepError } from "../../../../src/core/error-families/step-errors.js";
import { Enum, Text } from "../../../../src/dto/index.js";
import { Action, Workflow, WorkflowFinish, WorkflowStart, Ttl } from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";
import { onStart, toFinish } from "../../../helpers/flow.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { A2ATaskEnd } from "../../../../src/a2a/client/a2a-task-errors.js";

/** What the action throws: an error of a family that is none of the step's own (#1325b). */
export class ThrowDto {
  @Text({ prompt: "the id" })
  id!: string;

  @Enum(["a2a", "store", "config", "plain"], { prompt: "what is thrown" })
  throws!: "a2a" | "store" | "config" | "plain";
}

export class DoneDto {
  @Text({ prompt: "the result" })
  id!: string;
}

/** The error of the family `what` names. */
export function thrownOf(what: ThrowDto["throws"]): Error {
  if (what === "a2a")
    return new A2AError.TaskFailed({
      agent: "billing-a2a-agent",
      taskId: "t-1",
      contextId: "c-1",
      end: A2ATaskEnd.Failed,
    });
  if (what === "store")
    return new StoreError.LockTimeout({ message: "the store is locked by another process" });
  if (what === "config") return new ConfigError.Option({ message: "an option is not valid" });
  return new Error("plain");
}

@Action({
  name: "remote-call-action",
  description: "Calls a remote agent",
  input: { call: ThrowDto },
  output: DoneDto,
})
export class RemoteCallAction {
  execute(input: { readonly call: ThrowDto }): Promise<DoneDto> {
    return Promise.reject(thrownOf(input.call.throws));
  }
}

@WorkflowStart({ name: "step-catch-workflow-start", description: "A call", input: ThrowDto })
export class StepCatchStart {}

@WorkflowStart({ name: "remote-catch-workflow-start", description: "A call", input: ThrowDto })
export class RemoteCatchStart {}

@WorkflowStart({ name: "uncaught-workflow-start", description: "A call", input: ThrowDto })
export class UncaughtStart {}

@WorkflowFinish({ name: "family-done-workflow-finish", description: "Done", output: DoneDto })
export class FamilyDoneFinish {}

@WorkflowFinish({ name: "family-caught-workflow-finish", description: "Caught", output: ThrowDto })
export class FamilyCaughtFinish {}

/** The call's failure is taken by `.onError(StepError, …)`. */
@Workflow({
  name: "step-catch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(StepCatchStart)
      .toAction(RemoteCallAction)
      .onError(StepError, toFinish(FamilyCaughtFinish))
      .toFinish(FamilyDoneFinish),
  ],
})
export class StepCatchWorkflow {}

/** The same failure, taken by the remote error's own class (the wrapper's cause). */
@Workflow({
  name: "remote-catch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RemoteCatchStart)
      .toAction(RemoteCallAction)
      .onError(A2AError.TaskFailed, toFinish(FamilyCaughtFinish))
      .toFinish(FamilyDoneFinish),
  ],
})
export class RemoteCatchWorkflow {}

/** No side path: the failure fails the execution. */
@Workflow({
  name: "uncaught-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(UncaughtStart).toAction(RemoteCallAction).toFinish(FamilyDoneFinish)],
})
export class UncaughtWorkflow {}

@Application({
  name: "family-throw-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [StepCatchWorkflow, RemoteCatchWorkflow, UncaughtWorkflow],
  budgets: TEST_BUDGETS,
})
export class FamilyThrowApplication {}
