import {
  Action,
  ExecutionContext,
  FencedEffectRepository,
  NotSentTrust,
  OutboundCallReconciliation,
  OutboundCalls,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  effectKeyOf,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { BookingDto } from "./finished-undo.workflow.js";

/**
 * #825 — an undo that writes under a business key: a fenced effect and an outbound call, each with
 * its fingerprint, run by an automatic undo — a root's (the execution failed) and a child's (its own
 * failure, in its parent's node). The undo's frame carries the application's idempotency keys, as a
 * step's does: a business key's fingerprint is made there, never refused for want of a key.
 */

/** What the undo did: each refund booked and each refund sent, by booking. */
export const keyedUndoSeen = { booked: [] as string[], sent: [] as string[] };

@Action({
  name: "keyed-refund-action",
  description: "Refunds the booking under its business key: booked once, sent once",
  input: { booking: BookingDto },
  deps: [ExecutionContext, FencedEffectRepository, OutboundCalls],
})
export class KeyedRefundAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffectRepository: FencedEffectRepository<unknown>,
    private readonly outboundCalls: OutboundCalls,
  ) {}

  async execute(input: { readonly booking: Produced<BookingDto, unknown> }): Promise<void> {
    const { bookingId } = input.booking.value;
    const businessKey = `refund:${bookingId}`;
    const booked = effectKeyOf(this.executionContext, "book-refund", {
      businessKey,
      fingerprint: { bookingId },
    });
    await this.fencedEffectRepository.saveResultIfAbsent(booked, () => {
      keyedUndoSeen.booked.push(bookingId);
      return { bookingId };
    });
    await this.outboundCalls.send(effectKeyOf(this.executionContext, "refund", { businessKey }), {
      target: "payments",
      operation: "refund",
      request: { bookingId },
      send: () => {
        keyedUndoSeen.sent.push(bookingId);
        return { refundId: `refund-${bookingId}` };
      },
      notSent: { trust: NotSentTrust.Lookup },
      reconcile: () => OutboundCallReconciliation.notSent(),
    });
  }
}

@Action({
  name: "keyed-booking-action",
  description: "Books the item; its undo refunds it under the booking's business key",
  input: { item: ItemDto },
  output: BookingDto,
  compensateWith: KeyedRefundAction,
})
export class KeyedBookingAction {
  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<BookingDto> {
    return Promise.resolve({ bookingId: `booking-${input.item.value.name}` });
  }
}

@Action({
  name: "refusing-carrier-action",
  description: "The carrier refuses: the execution fails, its booking is undone",
  input: { item: ItemDto, booking: BookingDto },
  output: ItemResultDto,
})
export class RefusingCarrierAction {
  execute(): Promise<ItemResultDto> {
    return Promise.reject(new Error("the carrier refused"));
  }
}

@WorkflowStart({ name: "keyed-undo-workflow-start", description: "One item", input: ItemDto })
export class KeyedUndoWorkflowStart {}
@WorkflowFinish({ name: "keyed-undo-workflow-finish", description: "Done", output: ItemResultDto })
export class KeyedUndoWorkflowFinish {}

@Workflow({
  name: "keyed-undo-workflow",
  version: "1.0.0",
  flow: [
    start(KeyedUndoWorkflowStart)
      .returns(ItemDto)
      .toAction(KeyedBookingAction)
      .returns(BookingDto)
      .toAction(RefusingCarrierAction)
      .returns(ItemResultDto)
      .toFinish(KeyedUndoWorkflowFinish),
  ],
})
export class KeyedUndoWorkflow {}

@WorkflowStart({ name: "keyed-parent-workflow-start", description: "One item", input: ItemDto })
export class KeyedParentWorkflowStart {}
@WorkflowFinish({
  name: "keyed-parent-workflow-finish",
  description: "Done",
  output: ItemResultDto,
})
export class KeyedParentWorkflowFinish {}

@Workflow({
  name: "keyed-parent-workflow",
  version: "1.0.0",
  flow: [
    start(KeyedParentWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(KeyedUndoWorkflow)
      .returns(ItemResultDto)
      .toFinish(KeyedParentWorkflowFinish),
  ],
})
export class KeyedParentWorkflow {}

@Application({
  name: "keyed-undo-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [KeyedUndoWorkflow, KeyedParentWorkflow],
  budgets: TEST_BUDGETS,
})
export class KeyedUndoApplication {}
