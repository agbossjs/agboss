import {
  ChildPlacement,
  EmptyEnvironment,
  listOf,
  oneOf,
  ThisWorkflow,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { caseOf, start } from "../../helpers/flow.js";
import {
  HoldItemAction,
  PayAfterAction,
  PayCloseAction,
  PayItemAction,
  PayLevelAction,
  PayRemoteItemAction,
  RemoteItemsAction,
  SpendItemDto,
  SpendNodeDto,
  SpendNoteDto,
  SpendRemoteItemDto,
  SpendTreeApplicationBudget,
  SpendTreeExecutionBudget,
  SpendTreeLedger,
  SpendTreeLog,
  SpendTreeTenantBudget,
} from "./spend-tree.actions.js";

/**
 * #685 — one level of a planned tree of paid steps: the level pays, launches one child per item on
 * this instance and one per item on any instance (which pays and runs a child of its own here),
 * pays once more after them — a step checked right after the remote children's spend — and goes
 * one level deeper, a recursion on this instance (`spend-tree-workflow`) or on any instance
 * (`remote-spend-tree-workflow`), paying its close once that level returned — a step checked right
 * after a child whose own children ran on any instance.
 */

@WorkflowStart({ name: "spend-item-workflow-start", description: "A child", input: SpendItemDto })
export class SpendItemWorkflowStart {}
@WorkflowFinish({ name: "spend-item-workflow-finish", description: "Paid", output: SpendNoteDto })
export class SpendItemWorkflowFinish {}

/** A child on this instance: pays its cost. */
@Workflow({
  name: "spend-item-workflow",
  version: "1.0.0",
  flow: [
    start(SpendItemWorkflowStart)
      .returns(SpendItemDto)
      .toAction(PayItemAction)
      .returns(SpendNoteDto)
      .toFinish(SpendItemWorkflowFinish),
  ],
})
export class SpendItemWorkflow {}

@WorkflowStart({
  name: "spend-remote-item-workflow-start",
  description: "A child on any instance",
  input: SpendRemoteItemDto,
})
export class SpendRemoteItemWorkflowStart {}
@WorkflowFinish({
  name: "spend-remote-item-workflow-finish",
  description: "Paid",
  output: SpendNoteDto,
})
export class SpendRemoteItemWorkflowFinish {}

/**
 * A child on any instance: pays half its cost, is held while the test says (a takeover), pays the
 * other half in a child of its own, here.
 */
@Workflow({
  name: "spend-remote-item-workflow",
  version: "1.0.0",
  flow: [
    start(SpendRemoteItemWorkflowStart)
      .returns(SpendRemoteItemDto)
      .toAction(PayRemoteItemAction)
      .returns(SpendItemDto)
      .toAction(HoldItemAction)
      .toWorkflow(SpendItemWorkflow)
      .returns(SpendNoteDto)
      .toFinish(SpendRemoteItemWorkflowFinish),
  ],
})
export class SpendRemoteItemWorkflow {}

@WorkflowStart({ name: "spend-tree-workflow-start", description: "A level", input: SpendNodeDto })
export class SpendTreeWorkflowStart {}
@WorkflowFinish({ name: "spend-tree-workflow-finish", description: "Paid", output: SpendNoteDto })
export class SpendTreeWorkflowFinish {}

/** A level, its children, the step after them, the next level on this instance. */
@Workflow({
  name: "spend-tree-workflow",
  version: "1.0.0",
  flow: [
    start(SpendTreeWorkflowStart)
      .returns(SpendNodeDto)
      .toAction(PayLevelAction)
      .returns(listOf(SpendItemDto))
      .toParallelWorkflows(SpendItemWorkflow, { maxItems: 4 })
      .join()
      .returns(listOf(SpendNoteDto))
      .toAction(RemoteItemsAction)
      .returns(listOf(SpendRemoteItemDto))
      .toParallelWorkflows(SpendRemoteItemWorkflow, {
        maxItems: 4,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(SpendNoteDto))
      .toAction(PayAfterAction)
      .returns(oneOf(SpendNodeDto, SpendNoteDto))
      .switch(
        caseOf(SpendNodeDto)
          .toWorkflow(ThisWorkflow)
          .returns(SpendNoteDto)
          .toAction(PayCloseAction)
          .returns(SpendNoteDto)
          .toFinish(SpendTreeWorkflowFinish),
        caseOf(SpendNoteDto).toFinish(SpendTreeWorkflowFinish),
      ),
  ],
  maxDepth: 3,
})
export class SpendTreeWorkflow {}

@WorkflowStart({
  name: "remote-spend-tree-workflow-start",
  description: "A level",
  input: SpendNodeDto,
})
export class RemoteSpendTreeWorkflowStart {}
@WorkflowFinish({
  name: "remote-spend-tree-workflow-finish",
  description: "Paid",
  output: SpendNoteDto,
})
export class RemoteSpendTreeWorkflowFinish {}

/** The same level, the next one on any instance. */
@Workflow({
  name: "remote-spend-tree-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteSpendTreeWorkflowStart)
      .returns(SpendNodeDto)
      .toAction(PayLevelAction)
      .returns(listOf(SpendItemDto))
      .toParallelWorkflows(SpendItemWorkflow, { maxItems: 4 })
      .join()
      .returns(listOf(SpendNoteDto))
      .toAction(RemoteItemsAction)
      .returns(listOf(SpendRemoteItemDto))
      .toParallelWorkflows(SpendRemoteItemWorkflow, {
        maxItems: 4,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(SpendNoteDto))
      .toAction(PayAfterAction)
      .returns(oneOf(SpendNodeDto, SpendNoteDto))
      .switch(
        caseOf(SpendNodeDto)
          .toWorkflow(ThisWorkflow, { placement: ChildPlacement.AnyInstance })
          .returns(SpendNoteDto)
          .toAction(PayCloseAction)
          .returns(SpendNoteDto)
          .toFinish(RemoteSpendTreeWorkflowFinish),
        caseOf(SpendNoteDto).toFinish(RemoteSpendTreeWorkflowFinish),
      ),
  ],
  maxDepth: 3,
})
export class RemoteSpendTreeWorkflow {}

@Application({
  name: "spend-tree-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SpendTreeWorkflow, RemoteSpendTreeWorkflow],
  budgets: [SpendTreeApplicationBudget, SpendTreeTenantBudget, SpendTreeExecutionBudget],
  observers: [SpendTreeLog],
  providers: [SpendTreeLedger],
})
export class SpendTreeApplication {}
