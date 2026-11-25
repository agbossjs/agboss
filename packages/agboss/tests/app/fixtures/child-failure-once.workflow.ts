import {
  ChildExecutionFailedError,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toFinish } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import {
  EndOnceLocalWorkflow,
  EndOnceLog,
  YieldCheckLocalWorkflow,
} from "./child-end-once.workflow.js";
import { BookItemAction, ConfirmBookingAction } from "./finished-undo.workflow.js";
import { GatedItemAction } from "./remote-child-yield.workflow.js";

/**
 * #596 — a child's failure, once announced, is its end: the gated check of
 * `remote-child-yield.workflow.ts` on the parent's instance (a `…-flaky` item fails its first run
 * only), the same under a side path that takes the child's failure, and a child with an undo
 * (`finished-undo.workflow.ts`'s booking) on the parent's instance.
 */

@WorkflowStart({
  name: "undo-child-local-workflow-start",
  description: "One item to book and check",
  input: ItemDto,
})
export class UndoChildLocalWorkflowStart {}

@WorkflowFinish({
  name: "undo-child-local-workflow-finish",
  description: "The item, booked and checked",
  output: ItemResultDto,
})
export class UndoChildLocalWorkflowFinish {}

/** `undo-child-workflow`'s twin on the parent's instance (that one runs on any worker). */
@Workflow({
  name: "undo-child-local-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(UndoChildLocalWorkflowStart)
      .toAction(BookItemAction)
      .toAction(GatedItemAction)
      .toAction(ConfirmBookingAction)
      .toFinish(UndoChildLocalWorkflowFinish),
  ],
})
export class UndoChildLocalWorkflow {}

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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(UndoLocalWorkflowStart)
      .toWorkflow(UndoChildLocalWorkflow)
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SidePathLocalWorkflowStart)
      .toWorkflow(YieldCheckLocalWorkflow)
      .onError(ChildExecutionFailedError, toFinish(SidePathFailedWorkflowFinish))
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
