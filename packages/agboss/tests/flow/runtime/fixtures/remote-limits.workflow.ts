import {
  Action,
  Agent,
  ChildPlacement,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";
import { ItemDto, ItemResultDto, SummaryDto } from "./fan-out.workflow.js";
import {
  RemoteChecksWorkflowFinish,
  RemoteItemWorkflow,
  remoteLog,
} from "./remote-children.workflow.js";

/**
 * #333 PR 3 — the limits of a tree whose children run on any instance: `remote-capped-workflow`
 * launches six children on any instance under `maxConcurrentExecutions: 2` (its tree's slots shared
 * by the instances); `remote-spend-workflow` launches one child on any instance whose agent spends
 * (its spend written to the tree's counters where it runs, counted once).
 */

@WorkflowStart({
  name: "remote-capped-workflow-start",
  description: "The items to check, two at a time",
  input: listOf(ItemDto),
})
export class RemoteCappedWorkflowStart {}

/** Six children on any instance; at most two of the tree's executions work at once. */
@Workflow({
  name: "remote-capped-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteCappedWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(RemoteItemWorkflow, {
        maxConcurrency: 6,
        maxItems: 10,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(RemoteChecksWorkflowFinish),
  ],
  maxConcurrentExecutions: 2,
})
export class RemoteCappedWorkflow {}

@Agent({
  name: "remote-spender-agent",
  description: "Checks one item, at a cost",
  prompt: "Check the item.",
  model: "moonshotai/kimi-k2.6",
  input: { item: ItemDto },
  output: ItemResultDto,
})
export class RemoteSpenderAgent {}

/** Holds the child after its agent's step until the gate opens (a test reads the ledger then). */
@Action({
  name: "remote-hold-action",
  description: "Waits at the gate, then sums up the item",
  input: { result: ItemResultDto },
  output: SummaryDto,
})
export class RemoteHoldAction {
  async execute(input: { readonly result: Produced<ItemResultDto, unknown> }): Promise<SummaryDto> {
    const { gate } = remoteLog;
    if (gate !== undefined) {
      remoteLog.waiting += 1;
      await gate;
    }
    return { text: input.result.value.name };
  }
}

@WorkflowStart({
  name: "remote-spender-workflow-start",
  description: "One item to check at a cost",
  input: ItemDto,
})
export class RemoteSpenderWorkflowStart {}

@WorkflowFinish({
  name: "remote-spent-workflow-finish",
  description: "The item, checked at a cost",
  output: SummaryDto,
})
export class RemoteSpentWorkflowFinish {}

/** The child: an agent that spends, then a step that may wait. */
@Workflow({
  name: "remote-spender-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteSpenderWorkflowStart)
      .returns(ItemDto)
      .toAgent(RemoteSpenderAgent)
      .returns(ItemResultDto)
      .toAction(RemoteHoldAction)
      .returns(SummaryDto)
      .toFinish(RemoteSpentWorkflowFinish),
  ],
})
export class RemoteSpenderWorkflow {}

@WorkflowStart({
  name: "remote-spend-workflow-start",
  description: "One item, checked on any instance",
  input: ItemDto,
})
export class RemoteSpendWorkflowStart {}

@WorkflowFinish({
  name: "remote-spend-checked-workflow-finish",
  description: "The item, checked on any instance",
  output: SummaryDto,
})
export class RemoteSpendCheckedWorkflowFinish {}

/** One child on any instance that spends. */
@Workflow({
  name: "remote-spend-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteSpendWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(RemoteSpenderWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(SummaryDto)
      .toFinish(RemoteSpendCheckedWorkflowFinish),
  ],
})
export class RemoteSpendWorkflow {}

/** On the built-in in-memory stores: the test's instances share the queue and the slots. */
@Application({
  name: "remote-limits-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RemoteCappedWorkflow, RemoteSpendWorkflow],
  budgets: TEST_BUDGETS,
})
export class RemoteLimitsApplication {}
