import {
  Action,
  ApplicationContext,
  ChildExecutionFailedError,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { start, toFinish } from "../../../helpers/flow.js";
import { ItemDto, ItemFailedError, ItemResultDto, SummaryDto } from "./fan-out.workflow.js";

/**
 * #333 PR 2 — children on any instance (`placement: ChildPlacement.AnyInstance`): a code child
 * (`remote-item-workflow`: one action that logs which instance ran it and what its
 * `ExecutionContext` says, and fails on `outcome: "fail"`), launched per item and once.
 */

/** What one child's step saw: its instance and its place in the tree. */
export interface RemoteReading {
  readonly item: string;
  readonly instanceId: string;
  readonly executionId: string;
  readonly parentExecutionId: string | undefined;
  readonly rootExecutionId: string;
  readonly depth: number;
  readonly itemIndex: number | undefined;
  readonly parentStep: string | undefined;
  readonly rootWorkflow: string;
  readonly threadId: string;
  readonly tenantId: string;
}

export const remoteLog = {
  readings: [] as RemoteReading[],
  /** Holds every child until `release()` (a test that cancels while they run). */
  gate: undefined as Promise<void> | undefined,
  /** The children whose signal aborted at the gate, by item: where they ran. */
  aborted: [] as { readonly item: string; readonly instanceId: string }[],
  /** How many children have reached the gate. */
  waiting: 0,
};

/** Until the gate opens, or `signal` aborts (then it throws). */
function atGate(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    void gate.then(resolve);
    signal.addEventListener("abort", () => {
      reject(new Error("aborted at the gate"));
    });
  });
}

let releaseGate = (): void => undefined;

/** Children wait at the gate until `release()`. */
export function closeGate(): void {
  remoteLog.gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
}

export function release(): void {
  releaseGate();
  remoteLog.gate = undefined;
}

export function resetRemoteLog(): void {
  remoteLog.readings.length = 0;
  remoteLog.aborted.length = 0;
  remoteLog.waiting = 0;
  release();
}

@Action({
  name: "remote-check-action",
  description: "Checks one item and says where",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ExecutionContext, ApplicationContext],
})
export class RemoteCheckAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly applicationContext: ApplicationContext,
  ) {}

  async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    const { name, outcome } = input.item.value;
    const context = this.executionContext;
    remoteLog.readings.push({
      item: name,
      instanceId: this.applicationContext.instanceId,
      executionId: context.executionId,
      parentExecutionId: context.parent?.executionId,
      rootExecutionId: context.root.executionId,
      depth: context.depth,
      itemIndex: context.itemIndex,
      parentStep: context.parent?.step.nodeId,
      rootWorkflow: context.root.workflow.name,
      threadId: context.threadId,
      tenantId: context.tenant.tenantId,
    });
    const { gate } = remoteLog;
    if (gate !== undefined) {
      remoteLog.waiting += 1;
      try {
        await atGate(gate, context.signal);
      } catch (error) {
        remoteLog.aborted.push({ item: name, instanceId: this.applicationContext.instanceId });
        throw error;
      }
    }
    if (outcome === "fail") throw new ItemFailedError(`${name} cannot be checked`);
    return { name };
  }
}

@WorkflowStart({
  name: "remote-item-workflow-start",
  description: "One item to check",
  input: ItemDto,
})
export class RemoteItemWorkflowStart {}

@WorkflowFinish({
  name: "remote-item-checked-workflow-finish",
  description: "The item is checked",
  output: ItemResultDto,
})
export class RemoteItemCheckedWorkflowFinish {}

/** The child: one item, one action. */
@Workflow({
  name: "remote-item-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteItemWorkflowStart)
      .returns(ItemDto)
      .toAction(RemoteCheckAction)
      .returns(ItemResultDto)
      .toFinish(RemoteItemCheckedWorkflowFinish),
  ],
})
export class RemoteItemWorkflow {}

@WorkflowStart({
  name: "remote-items-workflow-start",
  description: "The items to check",
  input: listOf(ItemDto),
})
export class RemoteItemsWorkflowStart {}

@WorkflowFinish({
  name: "remote-checks-workflow-finish",
  description: "What was checked",
  input: { results: listOf(ItemResultDto) },
  output: SummaryDto,
})
export class RemoteChecksWorkflowFinish {
  finish(input: { readonly results: readonly Produced<ItemResultDto, unknown>[] }): SummaryDto {
    return {
      text: input.results
        .map((result) => result.value.name)
        .join(", "),
    };
  }
}

@WorkflowFinish({
  name: "remote-checks-failed-workflow-finish",
  description: "The items were not all checked",
  input: { items: listOf(ItemDto) },
  output: SummaryDto,
})
export class RemoteChecksFailedWorkflowFinish {
  finish(input: { readonly items: readonly Produced<ItemDto, unknown>[] }): SummaryDto {
    return { text: `failed on one of ${String(input.items.length)}` };
  }
}

/** One child per item on any instance; a failed child is caught by the join. */
@Workflow({
  name: "remote-items-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(RemoteItemWorkflow, {
        maxConcurrency: 6,
        maxItems: 10,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .onJoinError(ChildExecutionFailedError, toFinish(RemoteChecksFailedWorkflowFinish))
      .returns(listOf(ItemResultDto))
      .toFinish(RemoteChecksWorkflowFinish),
  ],
})
export class RemoteItemsWorkflow {}

@WorkflowStart({
  name: "remote-one-workflow-start",
  description: "One item",
  input: ItemDto,
})
export class RemoteOneWorkflowStart {}

@WorkflowFinish({
  name: "remote-one-checked-workflow-finish",
  description: "The item, checked",
  output: ItemResultDto,
})
export class RemoteOneCheckedWorkflowFinish {}

/** One child on any instance, no handler: its failure fails the execution. */
@Workflow({
  name: "remote-one-workflow",
  version: "1.0.0",
  flow: [
    start(RemoteOneWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(RemoteItemWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ItemResultDto)
      .toFinish(RemoteOneCheckedWorkflowFinish),
  ],
})
export class RemoteOneWorkflow {}

/** On the built-in in-memory stores: one instance (or a test's instances) claims its children. */
@Application({
  name: "remote-children-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RemoteItemsWorkflow, RemoteOneWorkflow],
  budgets: TEST_BUDGETS,
})
export class RemoteChildrenApplication {}
