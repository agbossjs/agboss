import {
  ChildExecutionFailedError,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start, toFinish } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { EndOnceLocalWorkflow, EndOnceLog } from "./child-end-once.workflow.js";
import { UndoChildWorkflow } from "./finished-undo.workflow.js";
import { YieldCheckWorkflow } from "./remote-child-yield.workflow.js";

/**
 * #596 — a child's failure, once announced, is its end: the gated check of
 * `remote-child-yield.workflow.ts` on the parent's instance (a `…-flaky` item fails its first run
 * only), the same under a side path that takes the child's failure, and a child with an undo
 * (`finished-undo.workflow.ts`'s booking) on the parent's instance.
 */

@WorkflowStart({
  name: "undo-local-workflow-start",
  description: "One item, booked and checked by a child on this instance",
  input: ItemDto,
})
export class UndoLocalWorkflowStart {}

@WorkflowFinish({
  name: "undo-local-workflow-finish",
  description: "The item the child checked",
  output: ItemResultDto,
})
export class UndoLocalWorkflowFinish {}

@Workflow({
  name: "undo-local-workflow",
  version: "1.0.0",
  flow: [
    start(UndoLocalWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(UndoChildWorkflow)
      .returns(ItemResultDto)
      .toFinish(UndoLocalWorkflowFinish),
  ],
})
export class UndoLocalWorkflow {}

@WorkflowStart({
  name: "side-path-local-workflow-start",
  description: "One item, checked by a child on this instance; its failure taken by a side path",
  input: ItemDto,
})
export class SidePathLocalWorkflowStart {}

@WorkflowFinish({
  name: "side-path-checked-workflow-finish",
  description: "The item the child checked",
  output: ItemResultDto,
})
export class SidePathCheckedWorkflowFinish {}

@WorkflowFinish({
  name: "side-path-failed-workflow-finish",
  description: "The item whose check failed",
  output: ItemDto,
})
export class SidePathFailedWorkflowFinish {}

@Workflow({
  name: "side-path-local-workflow",
  version: "1.0.0",
  flow: [
    start(SidePathLocalWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(YieldCheckWorkflow)
      .onError(ChildExecutionFailedError, toFinish(SidePathFailedWorkflowFinish))
      .returns(ItemResultDto)
      .toFinish(SidePathCheckedWorkflowFinish),
  ],
})
export class SidePathLocalWorkflow {}

@Application({
  name: "child-failure-once-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EndOnceLocalWorkflow, UndoLocalWorkflow, SidePathLocalWorkflow],
  observers: [EndOnceLog],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class ChildFailureOnceApplication {}
