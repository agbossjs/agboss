import { Text } from "../../../src/dto/index.js";
import {
  Action,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { GatedItemAction, YieldLog } from "./remote-child-yield.workflow.js";

/**
 * #520 acceptance — a compensated `AnyInstance` child: it books its item (undone by a cancel), then
 * passes the gate of `remote-child-yield.workflow.ts` and fails there for an item to fail, so it
 * ends failed after its undo ran; an item that passes has its booking confirmed. Every booking and
 * every cancel is kept with its instance, so a test sees that nothing ran twice.
 */

export class BookingDto {
  @Text({ prompt: "the booking's id" })
  bookingId!: string;
}

/** What the booking and its undo did, with the instance each ran on (reset with `resetUndo`). */
export const undoSeen = { booked: [] as string[], cancelled: [] as string[] };

export function resetUndo(): void {
  undoSeen.booked.length = 0;
  undoSeen.cancelled.length = 0;
}

@Action({
  name: "cancel-booking-action",
  description: "Cancels the booking",
  input: { booking: BookingDto },
  deps: [ExecutionContext],
})
export class CancelBookingAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly booking: Produced<BookingDto, unknown> }): Promise<void> {
    const { instanceId } = this.executionContext.tenant.application;
    undoSeen.cancelled.push(`${input.booking.value.bookingId} on ${instanceId}`);
    return Promise.resolve();
  }
}

@Action({
  name: "book-item-action",
  description: "Books the item",
  input: { item: ItemDto },
  output: BookingDto,
  compensateWith: CancelBookingAction,
  deps: [ExecutionContext],
})
export class BookItemAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<BookingDto> {
    const { instanceId } = this.executionContext.tenant.application;
    const bookingId = `booking-${input.item.value.name}`;
    undoSeen.booked.push(`${bookingId} on ${instanceId}`);
    return Promise.resolve({ bookingId });
  }
}

/** Confirms the booking once the item is checked (an item to fail never gets here). */
@Action({
  name: "confirm-booking-action",
  description: "Confirms the booking",
  input: { booking: BookingDto },
})
export class ConfirmBookingAction {
  execute(_input: { readonly booking: Produced<BookingDto, unknown> }): Promise<void> {
    return Promise.resolve();
  }
}

@WorkflowStart({
  name: "undo-child-workflow-start",
  description: "One item to book and check",
  input: ItemDto,
})
export class UndoChildWorkflowStart {}

@WorkflowFinish({
  name: "undo-child-workflow-finish",
  description: "The item, booked and checked",
  output: ItemResultDto,
})
export class UndoChildWorkflowFinish {}

@Workflow({
  name: "undo-child-workflow",
  version: "1.0.0",
  flow: [
    start(UndoChildWorkflowStart)
      .returns(ItemDto)
      .toAction(BookItemAction)
      .returns(BookingDto)
      .toAction(GatedItemAction)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(UndoChildWorkflowFinish),
  ],
})
export class UndoChildWorkflow {}

@WorkflowStart({
  name: "undo-one-workflow-start",
  description: "One item, booked and checked by a child on any instance",
  input: ItemDto,
})
export class UndoOneWorkflowStart {}

@WorkflowFinish({
  name: "undo-one-workflow-finish",
  description: "The item the child checked",
  output: ItemResultDto,
})
export class UndoOneWorkflowFinish {}

@Workflow({
  name: "undo-one-workflow",
  version: "1.0.0",
  flow: [
    start(UndoOneWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(UndoChildWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ItemResultDto)
      .toFinish(UndoOneWorkflowFinish),
  ],
})
export class UndoOneWorkflow {}

@Application({
  name: "finished-undo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UndoOneWorkflow],
  observers: [YieldLog],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class FinishedUndoApplication {}
