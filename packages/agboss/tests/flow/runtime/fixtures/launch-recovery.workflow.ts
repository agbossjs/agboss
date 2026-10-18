import {
  Action,
  EmptyEnvironment,
  ExecutionContext,
  listOf,
  Workflow,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../../infrastructure/fixtures/recovery.workflow.js";
import { start } from "../../../helpers/flow.js";
import {
  ItemDto,
  ItemResultDto,
  ItemsWorkflowStart,
  SummaryWorkflowFinish,
} from "./fan-out.workflow.js";

/**
 * #273 S20 (#265): a launch interrupted by its instance's stop — the item "hold" waits until its
 * execution is stopped, the others finish — and continued by another instance: only the
 * interrupted branch runs again, the finished ones' writes come from the checkpoint.
 */

/** How often each item ran, and the signal of each hold. */
export const recoveryRuns: { readonly runs: string[]; holdStarted?: () => void } = { runs: [] };

export function resetRecoveryRuns(): void {
  recoveryRuns.runs.length = 0;
  delete recoveryRuns.holdStarted;
}

@Action({
  name: "recoverable-item-action",
  description: "Processes one item; the first hold waits until the execution stops",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ExecutionContext],
})
export class RecoverableItemAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    const { name } = input.item.value;
    recoveryRuns.runs.push(name);
    const isFirstHold = name === "hold" && recoveryRuns.runs.filter((run) => run === name).length === 1;
    if (!isFirstHold) return Promise.resolve({ name });
    const { signal } = this.executionContext;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new Error("stopped"));
      });
      recoveryRuns.holdStarted?.();
    });
  }
}

@Workflow({
  name: "launch-recovery-workflow",
  version: "1.0.0",
  observers: [RecoveryLog],
  flow: [
    start(ItemsWorkflowStart)
      .returns(listOf(ItemDto))
      .toParallelActions(RecoverableItemAction, { maxItems: 10 })
      .join()
      .returns(listOf(ItemResultDto))
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class LaunchRecoveryWorkflow {}

@Application({
  name: "launch-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LaunchRecoveryWorkflow],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class LaunchRecoveryApplication {}
