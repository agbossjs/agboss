import { Flag, ListOf, Text } from "../../../dto/index.js";

/** An order the fault fixture moves: its id, and whether its charge declines for real. */
export class FaultOrderDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;

  @Flag({ prompt: "whether its charge declines" })
  decline!: boolean;
}

/** The order, reserved. */
export class FaultReservationDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;

  @Flag({ prompt: "whether its charge declines" })
  decline!: boolean;

  @Text({ prompt: "the reservation's id" })
  reservationId!: string;
}

/** The order, charged: the fenced business row's receipt. */
export class FaultChargeDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;

  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}

/** The order, paid at the gateway. */
export class FaultPaymentDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;

  @Text({ prompt: "the charge's id" })
  chargeId!: string;

  @Text({ prompt: "the gateway's payment id" })
  paymentId!: string;
}

/** A batch's outcome: the orders paid, in order. */
export class FaultBatchDto {
  @ListOf(Text, { prompt: "the orders paid" })
  orderIds!: string[];
}
