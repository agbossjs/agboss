import { Bool, Integer, Text } from "../../../src/dto/index.js";

/** DTOs of the #280 examples: the credit-limit flow and the support topics. */

export class CreditOrderDto {
  @Text({ prompt: "the customer who orders" })
  customerId!: string;

  @Integer({ prompt: "the order's total in whole dollars" })
  total!: number;
}

export class CreditApprovalDto {
  @Bool({ prompt: "whether the order is approved" })
  approved!: boolean;
}

export class ChargeResultDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}

/** What a customer's message is about, as types a code router decides on (never its text). */
export class SupportIntentDto {
  @Bool({ prompt: "whether the customer asks for a refund" })
  isRefund!: boolean;

  @Bool({ prompt: "whether the customer asks about the delivery" })
  isDelivery!: boolean;
}

export class TopicAnswerDto {
  @Text({ prompt: "the answer on one topic" })
  text!: string;
}
