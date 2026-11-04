import {
  Action,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { ItemDto, ItemResultDto, SummaryDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";

/**
 * #767 — a worker's room to claim children on any instance: `claim-room-batch-workflow` launches
 * up to twelve children on any instance at once (`claim-room-item-workflow`: one action held at its
 * own item's gate until the test opens it); the instance runs three steps at a time
 * (`maxConcurrentSteps: 3`). `claim-room-item-workflow-start` runs the same held action as a root,
 * a step of the instance's that is no claimed child.
 */

/** The held steps at work now, by item, and the most at work at once. */
export const roomLog = {
  atWork: new Set<string>(),
  most: 0,
  gates: new Map<string, () => void>(),
};

export function resetRoomLog(): void {
  roomLog.atWork.clear();
  roomLog.most = 0;
  for (const open of roomLog.gates.values()) open();
  roomLog.gates.clear();
}

/** Opens the gate of `item`'s step, which then ends. */
export function releaseItem(item: string): void {
  const open = roomLog.gates.get(item);
  if (open === undefined) throw new Error(`no step of ${item} waits at its gate`);
  roomLog.gates.delete(item);
  open();
}

/** Until the test opens `item`'s gate, or `signal` aborts (then it throws). */
function atItemGate(item: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    roomLog.gates.set(item, resolve);
    signal.addEventListener("abort", () => {
      reject(new Error("aborted at the gate"));
    });
  });
}

@Action({
  name: "claim-room-hold-action",
  description: "Holds its step at the item's gate, then checks the item",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ExecutionContext],
})
export class ClaimRoomHoldAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    const { name } = input.item.value;
    roomLog.atWork.add(name);
    roomLog.most = Math.max(roomLog.most, roomLog.atWork.size);
    try {
      await atItemGate(name, this.executionContext.signal);
    } finally {
      roomLog.atWork.delete(name);
    }
    return { name };
  }
}

@WorkflowStart({
  name: "claim-room-item-workflow-start",
  description: "One item to check",
  input: ItemDto,
})
export class ClaimRoomItemWorkflowStart {}

@WorkflowFinish({
  name: "claim-room-item-workflow-finish",
  description: "The item is checked",
  output: ItemResultDto,
})
export class ClaimRoomItemWorkflowFinish {}

/** The child: one item, one held action. */
@Workflow({
  name: "claim-room-item-workflow",
  version: "1.0.0",
  flow: [
    start(ClaimRoomItemWorkflowStart)
      .returns(ItemDto)
      .toAction(ClaimRoomHoldAction)
      .returns(ItemResultDto)
      .toFinish(ClaimRoomItemWorkflowFinish),
  ],
})
export class ClaimRoomItemWorkflow {}

@WorkflowStart({
  name: "claim-room-batch-workflow-start",
  description: "Items to check, each a child on any instance",
  input: listOf(ItemDto),
})
export class ClaimRoomBatchWorkflowStart {}

@WorkflowFinish({
  name: "claim-room-batch-workflow-finish",
  description: "What was checked",
  input: { results: listOf(ItemResultDto) },
  output: SummaryDto,
})
export class ClaimRoomBatchWorkflowFinish {
  finish(input: { readonly results: readonly Produced<ItemResultDto, unknown>[] }): SummaryDto {
    return {
      text: input.results
        .map((result) => result.value.name)
        .join(", "),
    };
  }
}

/** Every item a child on any instance, all launched at once. */
@Workflow({
  name: "claim-room-batch-workflow",
  version: "1.0.0",
  maxConcurrentExecutions: 30,
  flow: [
    start(ClaimRoomBatchWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelWorkflows(ClaimRoomItemWorkflow, {
        maxConcurrency: 12,
        maxItems: 12,
        placement: ChildPlacement.AnyInstance,
      })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(ClaimRoomBatchWorkflowFinish),
  ],
})
export class ClaimRoomBatchWorkflow {}

/** Three steps at a time on the instance. */
@Application({
  name: "claim-room-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClaimRoomBatchWorkflow, ClaimRoomItemWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 3,
})
export class ClaimRoomApplication {}

/** `count` items, all `ok`, named `item-0`, `item-1`, … */
export const roomItemsOf = (count: number): ItemDto[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `item-${String(index)}`,
    delay: 0,
    outcome: "ok" as const,
  }));
