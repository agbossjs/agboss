import {
  ChildPlacement,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { caseOf, onStart } from "../../helpers/flow.js";
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
    onStart(SpendItemWorkflowStart)
      .toAction(PayItemAction)
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
  placement: ChildPlacement.AnyWorker,
  name: "spend-remote-item-workflow",
  version: "1.0.0",
  flow: [
    onStart(SpendRemoteItemWorkflowStart)
      .toAction(PayRemoteItemAction)
      .toAction(HoldItemAction)
      .toWorkflow(SpendItemWorkflow)
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
    onStart(SpendTreeWorkflowStart)
      .toAction(PayLevelAction)
      .toParallelWorkflows(SpendItemWorkflow, { maxItems: 4 })
      .join()
      .toAction(RemoteItemsAction)
      .toParallelWorkflows(SpendRemoteItemWorkflow, {
        maxItems: 4,
      })
      .join()
      .toAction(PayAfterAction)
      .switch(
        caseOf(SpendNodeDto)
          .toWorkflow(() => SpendTreeWorkflow)
          .toAction(PayCloseAction)
          .toFinish(SpendTreeWorkflowFinish),
        caseOf(SpendNoteDto)
          .toFinish(SpendTreeWorkflowFinish),
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
  placement: ChildPlacement.AnyWorker,
  name: "remote-spend-tree-workflow",
  version: "1.0.0",
  flow: [
    onStart(RemoteSpendTreeWorkflowStart)
      .toAction(PayLevelAction)
      .toParallelWorkflows(SpendItemWorkflow, { maxItems: 4 })
      .join()
      .toAction(RemoteItemsAction)
      .toParallelWorkflows(SpendRemoteItemWorkflow, {
        maxItems: 4,
      })
      .join()
      .toAction(PayAfterAction)
      .switch(
        caseOf(SpendNodeDto)
          .toWorkflow(() => RemoteSpendTreeWorkflow)
          .toAction(PayCloseAction)
          .toFinish(RemoteSpendTreeWorkflowFinish),
        caseOf(SpendNoteDto)
          .toFinish(RemoteSpendTreeWorkflowFinish),
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
