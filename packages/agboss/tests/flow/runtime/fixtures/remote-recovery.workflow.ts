import {
  Action,
  ApplicationContext,
  ChildExecutionFailedError,
  ChildPlacement,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowStart,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../../infrastructure/fixtures/recovery.workflow.js";
import { RecordingLogger } from "../../../helpers/log.js";
import { onStart, toFinish, toAction } from "../../../helpers/flow.js";
import { ItemDto, SummaryWorkflowFinish, SummaryAction } from "./fan-out.workflow.js";
import {
  ChecksFailedWorkflowFinish,
  ChildEventLog,
  ItemReviewedWorkflowFinish,
  ItemReviewWorkflow,
  ReviewsSummaryWorkflowFinish,
  ShopExecutionContext,
  ShopTenantContext,
  ChecksFailedAction,
  ReviewsSummaryAction,
} from "./children.workflow.js";
import { HoldCheckedWorkflowFinish, HoldCheckWorkflowStart } from "./child-recovery.workflow.js";
import { RecoverableItemAction, recoveryRuns } from "./launch-recovery.workflow.js";

/**
 * #333 PR 4 — remote children (`ChildPlacement.AnyWorker`) that pause, yield the parent's root
 * lease while running, and recover per child from `<parentThreadId>/child/<id>` on a worker crash
 * or a graceful stop past `shutdownTimeout` (S7) without re-running finished siblings or finished
 * steps of the child.
 */

export const remoteRecoverySeen = {
  prepRuns: [] as string[],
  holdInstanceId: undefined as string | undefined,
};

export function resetRemoteRecoverySeen(): void {
  remoteRecoverySeen.prepRuns.length = 0;
  remoteRecoverySeen.holdInstanceId = undefined;
}

/** First step of the recoverable remote child: checkpoints before the second step holds. */
@Action({
  name: "remote-prep-item-action",
  description: "Prepares one item before the step that may hold",
  input: { item: ItemDto },
  output: ItemDto,
  deps: [ApplicationContext],
})
export class RemotePrepItemAction {
  constructor(private readonly applicationContext: ApplicationContext) {}

  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemDto> {
    const { name, outcome } = input.item.value;
    if (outcome === "fail") return Promise.reject(new Error(`failed: ${name}`));
    remoteRecoverySeen.prepRuns.push(name);
    if (name === "hold" && remoteRecoverySeen.holdInstanceId === undefined)
      remoteRecoverySeen.holdInstanceId = this.applicationContext.instanceId;
    return Promise.resolve(input.item.value);
  }
}

@Workflow({
  placement: ChildPlacement.AnyWorker,
  name: "remote-hold-check-workflow",
  version: "1.0.0",
  flow: [
    onStart(HoldCheckWorkflowStart)
      .toAction(RemotePrepItemAction)
      .toAction(RecoverableItemAction)
      .toFinish(HoldCheckedWorkflowFinish),
  ],
})
export class RemoteHoldCheckWorkflow {}

@WorkflowStart({
  name: "remote-hold-items-workflow-start",
  description: "Items checked by remote children",
  input: listOf(ItemDto),
})
export class RemoteHoldItemsWorkflowStart {}

@Workflow({
  name: "remote-hold-items-workflow",
  version: "1.0.0",
  flow: [
    onStart(RemoteHoldItemsWorkflowStart)
      .toParallelWorkflows(RemoteHoldCheckWorkflow, {
        maxItems: 10,
      })
      .join()
      .onError(
        ChildExecutionFailedError,
        toAction(ChecksFailedAction).toFinish(ChecksFailedWorkflowFinish),
      )
      .toAction(SummaryAction)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class RemoteHoldItemsWorkflow {}

@WorkflowStart({
  name: "remote-review-one-workflow-start",
  description: "One item reviewed on any instance",
  input: ItemDto,
})
export class RemoteReviewOneWorkflowStart {}

@Workflow({
  name: "remote-review-one-workflow",
  version: "1.0.0",
  flow: [
    onStart(RemoteReviewOneWorkflowStart)
      .toWorkflow(ItemReviewWorkflow)
      .toFinish(ItemReviewedWorkflowFinish),
  ],
})
export class RemoteReviewOneWorkflow {}

@WorkflowStart({
  name: "remote-review-items-workflow-start",
  description: "Items reviewed on any instance",
  input: listOf(ItemDto),
})
export class RemoteReviewItemsWorkflowStart {}

@Workflow({
  name: "remote-review-items-workflow",
  version: "1.0.0",
  flow: [
    onStart(RemoteReviewItemsWorkflowStart)
      .toParallelWorkflows(ItemReviewWorkflow, {
        maxConcurrency: 2,
        maxItems: 10,
      })
      .join()
      .toAction(ReviewsSummaryAction)
      .toFinish(ReviewsSummaryWorkflowFinish),
  ],
})
export class RemoteReviewItemsWorkflow {}

@Application({
  name: "remote-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  tenantContext: ShopTenantContext,
  executionContext: ShopExecutionContext,
  workflows: [
    RemoteHoldItemsWorkflow,
    RemoteReviewOneWorkflow,
    RemoteReviewItemsWorkflow,
    ItemReviewWorkflow,
  ],
  observers: [RecoveryLog, ChildEventLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository, RecordingLogger],
  budgets: TEST_BUDGETS,
  defaults: { workflows: { placement: ChildPlacement.AnyWorker } },
})
export class RemoteRecoveryApplication {}

export { recoveryRuns };
