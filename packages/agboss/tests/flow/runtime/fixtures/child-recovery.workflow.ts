import {
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../../infrastructure/fixtures/recovery.workflow.js";
import { start } from "../../../helpers/flow.js";
import { ItemDto, ItemResultDto, SummaryWorkflowFinish } from "./fan-out.workflow.js";
import { RecoverableItemAction } from "./launch-recovery.workflow.js";
import { ChildEventLog } from "./children.workflow.js";

/**
 * #263 S24 (#265): a child interrupted by its instance's stop — the item "hold" waits inside its
 * child until the execution is stopped, its siblings' children finish — and continued by another
 * instance: only the interrupted child goes on, with the id it started with.
 */

@WorkflowStart({
  name: "hold-check-workflow-start",
  description: "One item, maybe held",
  input: ItemDto,
})
export class HoldCheckWorkflowStart {}

@WorkflowFinish({
  name: "hold-checked-workflow-finish",
  description: "The item, done",
  output: ItemResultDto,
})
export class HoldCheckedWorkflowFinish {}

@Workflow({
  name: "hold-check-workflow",
  version: "1.0.0",
  flow: [
    start(HoldCheckWorkflowStart)
      .returns(ItemDto)
      .toAction(RecoverableItemAction)
      .returns(ItemResultDto)
      .toFinish(HoldCheckedWorkflowFinish),
  ],
})
export class HoldCheckWorkflow {}

@WorkflowStart({
  name: "hold-items-workflow-start",
  description: "The items, each in its own child",
  input: listOf(ItemDto),
})
export class HoldItemsWorkflowStart {}

@Workflow({
  name: "hold-items-workflow",
  version: "1.0.0",
  flow: [
    start(HoldItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(HoldCheckWorkflow, { maxItems: 10 })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class HoldItemsWorkflow {}

@Application({
  name: "child-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HoldItemsWorkflow],
  observers: [RecoveryLog, ChildEventLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class ChildRecoveryApplication {}
