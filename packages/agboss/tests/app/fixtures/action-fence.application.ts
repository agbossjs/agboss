/**
 * #662 — an action's holder held in the action's `onActionStart` (an observer, or the PII mask of
 * its event — a model call with `detectWithModel` — taking long) while its lease runs out: the
 * undo action of a side path (`.onError(StepFailedError, toAction(CancelBookingAction))`, it closes
 * the booking's entry) and a charge on the main path. The first `onActionStart` of the armed action
 * is held until the test lets it go; every charge is kept with its instance.
 */
import {
  Action,
  ApplicationContext,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  StepFailedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionStartEvent,
  type OnActionStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start, toAction } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { EndOnceLog } from "./child-end-once.workflow.js";
import { FinishLog, MatrixCheckpointSaver } from "./end-once-matrix.workflow.js";
import {
  BookItemAction,
  BookingDto,
  CancelBookingAction,
  ConfirmBookingAction,
} from "./finished-undo.workflow.js";
import { GatedItemAction } from "./remote-child-yield.workflow.js";

/** The armed action, who was held in its `onActionStart`, how to let it go; every charge made. */
export const actionGate = {
  action: undefined as string | undefined,
  held: [] as string[],
  release: (): void => undefined,
  charged: [] as string[],
};

export function armActionGate(action: string): void {
  actionGate.action = action;
  actionGate.held.length = 0;
  actionGate.charged.length = 0;
  actionGate.release = () => undefined;
}

/** Holds the first `onActionStart` of the armed action (then disarms), on whichever instance. */
@Injectable({ deps: [ApplicationContext] })
export class ActionStartGate implements OnActionStart {
  constructor(private readonly applicationContext: ApplicationContext) {}

  onActionStart(event: ActionStartEvent): Promise<void> | undefined {
    if (actionGate.action !== event.name) return undefined;
    actionGate.action = undefined;
    actionGate.held.push(this.applicationContext.instanceId);
    return new Promise((resolve) => {
      actionGate.release = resolve;
    });
  }
}

@Action({
  name: "charge-item-action",
  description: "Charges the checked item (an effect outside any fence)",
  input: { result: ItemResultDto },
  output: ItemResultDto,
  deps: [ExecutionContext],
})
export class ChargeItemAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly result: { readonly value: ItemResultDto } }): Promise<ItemResultDto> {
    const { instanceId } = this.executionContext.tenant.application;
    actionGate.charged.push(`${input.result.value.name} on ${instanceId}`);
    return Promise.resolve(input.result.value);
  }
}

@WorkflowStart({ name: "side-undo-workflow-start", description: "One item", input: ItemDto })
export class SideUndoWorkflowStart {}
@WorkflowFinish({ name: "side-undone-workflow-finish", description: "Undone", output: BookingDto })
export class SideUndoneWorkflowFinish {}
@WorkflowFinish({ name: "side-kept-workflow-finish", description: "Kept", output: ItemResultDto })
export class SideKeptWorkflowFinish {}

/** Booked, then checked; a failed check's side path cancels the booking (its undo). */
@Workflow({
  name: "side-undo-workflow",
  version: "1.0.0",
  flow: [
    start(SideUndoWorkflowStart)
      .returns(ItemDto)
      .toAction(BookItemAction)
      .returns(BookingDto)
      .toAction(GatedItemAction)
      .onError(StepFailedError, toAction(CancelBookingAction).toFinish(SideUndoneWorkflowFinish))
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(SideKeptWorkflowFinish),
  ],
})
export class SideUndoWorkflow {}

@WorkflowStart({ name: "charge-workflow-start", description: "One item", input: ItemDto })
export class ChargeWorkflowStart {}
@WorkflowFinish({ name: "charged-workflow-finish", description: "Charged", output: ItemResultDto })
export class ChargedWorkflowFinish {}

/** Checked, then charged. */
@Workflow({
  name: "charge-workflow",
  version: "1.0.0",
  flow: [
    start(ChargeWorkflowStart)
      .returns(ItemDto)
      .toAction(GatedItemAction)
      .returns(ItemResultDto)
      .toAction(ChargeItemAction)
      .returns(ItemResultDto)
      .toFinish(ChargedWorkflowFinish),
  ],
})
export class ChargeWorkflow {}

@Application({
  name: "action-fence-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SideUndoWorkflow, ChargeWorkflow],
  observers: [EndOnceLog, FinishLog, ActionStartGate],
  providers: [RecordingLogger, MatrixCheckpointSaver],
  budgets: TEST_BUDGETS,
})
export class ActionFenceApplication {}
