import { Text } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";

/**
 * #339 — the parts of the compensation rules' workflows: a booking (undone by its cancel, committed
 * by the confirmation), a charge (undone by a refund, committed by a finish), a letter that may
 * fail between them and the confirmation, and the finishes of both outcomes.
 */

export class TripRequestDto {
  @Text({ prompt: "what to book" })
  trip!: string;
}

export class BookingDto {
  @Text({ prompt: "the booking's id" })
  bookingId!: string;
}

export class PaymentDto {
  @Text({ prompt: "the payment's id" })
  paymentId!: string;
}

export class TripLetterDto {
  @Text({ prompt: "the letter to the traveller" })
  text!: string;
}

export class TripConfirmedDto {
  @Text({ prompt: "the confirmed booking's id" })
  bookingId!: string;
}

/** A code step that does its work for its side effect only. */
class SideEffect {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

@Action({
  name: "cancel-booking-action",
  description: "Cancels the booking",
  input: { booking: BookingDto },
})
export class CancelBookingAction extends SideEffect {}

@Action({
  name: "refund-action",
  description: "Refunds the payment",
  input: { payment: PaymentDto },
})
export class RefundAction extends SideEffect {}

@Action({
  name: "confirm-trip-action",
  description: "Confirms the booking",
  input: { booking: BookingDto },
  output: TripConfirmedDto,
})
export class ConfirmTripAction extends SideEffect {}

@Action({
  name: "book-trip-action",
  description: "Books the trip",
  input: { request: TripRequestDto },
  output: BookingDto,
  compensateWith: CancelBookingAction,
  committedBy: ConfirmTripAction,
})
export class BookTripAction extends SideEffect {}

@Action({
  name: "charge-action",
  description: "Charges the traveller",
  input: { booking: BookingDto },
  output: PaymentDto,
  compensateWith: RefundAction,
})
export class ChargeAction extends SideEffect {}

@Action({
  name: "notify-agency-action",
  description: "Tells a person",
  input: { request: TripRequestDto },
})
export class NotifyAgencyAction extends SideEffect {}

@Agent({
  name: "trip-letter-agent",
  description: "Writes the letter",
  prompt: "Write the letter.",
  model: "moonshotai/kimi-k2.6",
  input: { booking: BookingDto },
  output: TripLetterDto,
})
export class TripLetterAgent {}

@WorkflowStart({
  name: "trip-workflow-start",
  description: "A trip to book",
  input: TripRequestDto,
})
export class TripWorkflowStart {}

@WorkflowFinish({
  name: "trip-booked-workflow-finish",
  description: "Booked",
  output: TripConfirmedDto,
})
export class TripBookedWorkflowFinish {}

@WorkflowFinish({
  name: "trip-not-booked-workflow-finish",
  description: "Not booked",
  output: TripRequestDto,
})
export class TripNotBookedWorkflowFinish {}
